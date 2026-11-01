(() => {
  const MAX_FILE = 15 * 1024 * 1024;
  const MAX_TEXT_BYTES = 3900;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.hash.slice(1));
  let topic = params.get("t");
  let server = params.get("s");
  try {
    if (topic) {
      localStorage.setItem("dropTopic", topic);
      if (server) localStorage.setItem("dropServer", server);
      else localStorage.removeItem("dropServer");
    } else {
      topic = localStorage.getItem("dropTopic");
      server = localStorage.getItem("dropServer");
    }
  } catch {}
  server = (server || "https://ntfy.sh").replace(/\/$/, "");

  if (!topic || !/^[A-Za-z0-9_-]{16,64}$/.test(topic)) {
    $("unpaired").hidden = false;
    return;
  }
  $("app").hidden = false;

  const queue = [];
  let running = false;
  let failures = 0;

  function setStatus(text, kind) {
    $("status").textContent = text;
    document.querySelector(".dot").className = `dot${kind ? ` ${kind}` : ""}`;
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  const CHECK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m8.5 8.5 7 7m0-7-7 7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';

  function addRow(item) {
    $("recentTitle").hidden = false;
    const li = document.createElement("li");
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (item.file && item.file.type.startsWith("image/") && item.file.size < 25 * 1024 * 1024) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = URL.createObjectURL(item.file);
      img.onload = () => URL.revokeObjectURL(img.src);
      thumb.append(img);
    } else if (item.text !== undefined) {
      thumb.textContent = /^https?:\/\//i.test(item.text) ? "LINK" : "TEXT";
    } else {
      const m = /\.([a-z0-9]{1,5})$/i.exec(item.name);
      thumb.textContent = m ? m[1].toUpperCase() : "FILE";
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const b = document.createElement("b");
    b.textContent = item.label;
    const small = document.createElement("small");
    small.textContent = item.file ? fmtBytes(item.file.size) : "Waiting…";
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    bar.append(fill);
    meta.append(b, small, bar);
    const state = document.createElement("div");
    state.className = "state";
    li.append(thumb, meta, state);
    $("list").prepend(li);
    item.ui = { small, bar, fill, state };
  }

  function finish(item, ok, note) {
    const { small, bar, state } = item.ui;
    bar.remove();
    small.textContent = note;
    state.className = `state ${ok ? "ok" : "err"}`;
    state.innerHTML = ok ? CHECK : CROSS;
  }

  function xhrPost(url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let progressed = false;
      xhr.open("POST", url);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          progressed = true;
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error(xhr.status === 413 ? "too-big" : xhr.status === 429 ? "rate" : `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => {
        const err = new Error("network");
        err.progressed = progressed;
        reject(err);
      };
      xhr.send(body);
    });
  }

  async function post(url, body, onProgress) {
    try {
      return await xhrPost(url, body, onProgress);
    } catch (err) {
      if (err.message !== "network" || err.progressed || !onProgress) throw err;
      onProgress(0.5);
      return xhrPost(url, body, null);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const item = queue.shift();
      const left = queue.length;
      setStatus(left ? `Sending… ${left} more after this` : "Sending…", "busy");
      try {
        if (item.file) {
          if (item.file.size > MAX_FILE) throw new Error("too-big");
          const url = `${server}/${topic}?filename=${encodeURIComponent(item.name)}&tags=file`;
          await post(url, new Blob([item.file]), (p) => {
            item.ui.fill.style.width = `${(p * 100).toFixed(1)}%`;
            item.ui.small.textContent = `${fmtBytes(Math.round(item.file.size * p))} of ${fmtBytes(item.file.size)}`;
          });
          finish(item, true, `${fmtBytes(item.file.size)} · Sent`);
        } else {
          const bytes = new TextEncoder().encode(item.text).length;
          if (bytes <= MAX_TEXT_BYTES) {
            await post(`${server}/${topic}?tags=text`, item.text);
          } else {
            await post(`${server}/${topic}?filename=${encodeURIComponent("Note.txt")}&tags=file`, new Blob([item.text]));
          }
          finish(item, true, "Sent");
        }
        failures = 0;
      } catch (err) {
        failures++;
        finish(item, false, err.message === "too-big"
          ? "Too big · 15 MB max"
          : err.message === "rate"
            ? "Too many at once · try again shortly"
            : "Couldn't send · check your connection");
      }
    }
    running = false;
    setStatus(failures ? "Something didn't send" : "Ready", failures ? "err" : "");
  }

  function enqueueFiles(files) {
    for (const file of files) {
      const name = file.name && file.name !== "image.jpg" && file.name !== "image.png"
        ? file.name
        : `Photo ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).replace(":", ".")}.${(file.type.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
      const item = { file, name, label: name };
      addRow(item);
      queue.push(item);
    }
    run();
  }

  ["pickPhotos", "pickCamera", "pickFiles"].forEach((id) => {
    $(id).addEventListener("change", (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) enqueueFiles(files);
    });
  });

  const ta = $("text");
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    $("sendText").disabled = !ta.value.trim();
    $("paste").hidden = !!ta.value;
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    const item = { text, label: text.length > 60 ? `${text.slice(0, 60)}…` : text };
    addRow(item);
    queue.push(item);
    ta.value = "";
    grow();
    run();
  });

  $("paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        ta.value = text;
        grow();
        ta.focus();
      }
    } catch {
      ta.focus();
    }
  });

  addEventListener("paste", (e) => {
    if (e.target === ta) return;
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.length) {
      e.preventDefault();
      enqueueFiles(files);
    }
  });

  grow();
})();
