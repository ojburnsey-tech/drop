(() => {
  const MAX_FILE = 15 * 1024 * 1024;
  const SHRINK_TARGET = 14 * 1024 * 1024;
  const MAX_TEXT_BYTES = 3900;
  const MAX_HISTORY = 300;
  const ONLINE_MS = 3 * 60 * 1000;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.hash.slice(1));
  let topic = params.get("t");
  let server = params.get("s");
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`drop.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`drop.${k}`, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(`drop.${k}`); } catch {} }
  };

  if (topic) {
    if (topic !== store.get("topic", null)) {
      store.del("thread");
      store.del("since");
    }
    store.set("topic", topic);
    store.set("server", server || null);
  } else {
    topic = store.get("topic", null);
    server = store.get("server", null);
  }
  server = (server || "https://ntfy.sh").replace(/\/$/, "");
  const validTopic = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);

  function pairFromLink(raw) {
    try {
      const u = new URL(raw.trim());
      const p = new URLSearchParams(u.hash.slice(1));
      if (!validTopic(p.get("t"))) return false;
      location.replace(`${location.pathname}#${u.hash.slice(1)}`);
      location.reload();
      return true;
    } catch {
      return false;
    }
  }

  if (!validTopic(topic)) {
    $("unpaired").hidden = false;
    $("pairForm").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!pairFromLink($("pairInput").value)) toast("That isn't a Drop pairing link");
    });
    return;
  }

  const CHAT = topic;
  const CTL = `${topic}c`;
  $("app").hidden = false;

  const db = {
    handle: null,
    open() {
      if (this.handle) return Promise.resolve(this.handle);
      return new Promise((res, rej) => {
        const r = indexedDB.open("drop", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("thumbs");
        r.onsuccess = () => { this.handle = r.result; res(this.handle); };
        r.onerror = () => rej(r.error);
      });
    },
    async get(k) {
      try {
        const d = await this.open();
        return await new Promise((res) => {
          const q = d.transaction("thumbs").objectStore("thumbs").get(k);
          q.onsuccess = () => res(q.result || null);
          q.onerror = () => res(null);
        });
      } catch { return null; }
    },
    async put(k, v) {
      try {
        const d = await this.open();
        d.transaction("thumbs", "readwrite").objectStore("thumbs").put(v, k);
      } catch {}
    },
    async del(k) {
      try {
        const d = await this.open();
        d.transaction("thumbs", "readwrite").objectStore("thumbs").delete(k);
      } catch {}
    },
    async clear() {
      try {
        const d = await this.open();
        d.transaction("thumbs", "readwrite").objectStore("thumbs").clear();
      } catch {}
    }
  };

  let thread = store.get("thread", []);
  let since = store.get("since", 0);
  const seen = new Set(thread.map((i) => i.id));
  let presence = store.get("presence", null);
  let note = store.get("note", { text: "", at: 0 });
  let source = null;
  let lastHello = 0;

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2000);
  }

  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    const d = Math.round(h / 24);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }

  function clock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabel(ms) {
    const d = new Date(ms);
    const today = new Date();
    const y = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  }

  const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());
  const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; };
  const isImageName = (name, type) => (type || "").startsWith("image/") || /^(jpe?g|png|gif|webp|heic|heif)$/.test(extOf(name));

  function save() {
    thread.sort((a, b) => a.time - b.time);
    if (thread.length > MAX_HISTORY) {
      thread.splice(0, thread.length - MAX_HISTORY).forEach((i) => db.del(i.id));
    }
    store.set("thread", thread.filter((i) => i.status !== "sending").map((i) => {
      const { progress, ...rest } = i;
      return rest;
    }));
  }

  function itemFromMsg(msg) {
    const tags = msg.tags || [];
    const base = {
      id: msg.id,
      time: msg.time * 1000,
      dir: tags.includes("from-laptop") ? "in" : "out",
      status: "sent"
    };
    if (msg.attachment) {
      return {
        ...base,
        kind: "file",
        name: msg.attachment.name || "File",
        type: msg.attachment.type || "",
        size: msg.attachment.size || 0,
        url: msg.attachment.url,
        expires: msg.attachment.expires ? msg.attachment.expires * 1000 : base.time + 3 * 36e5
      };
    }
    if (tags.includes("filelink")) {
      const sizeTag = tags.find((t) => t.startsWith("s:"));
      return { ...base, kind: "file", name: msg.title || "File", url: (msg.message || "").trim(), size: sizeTag ? Number(sizeTag.slice(2)) : 0, type: "", expires: base.time + 72 * 36e5 };
    }
    const text = msg.message || "";
    if (tags.includes("open") || tags.includes("link") || isUrl(text)) {
      return { ...base, kind: "link", text: text.trim(), opened: tags.includes("open") };
    }
    return { ...base, kind: "text", text };
  }

  function matchPending(item) {
    if (item.dir !== "out") return null;
    return thread.find((p) => p.id.startsWith("tmp-") && p.dir === "out" && p.kind === item.kind && (p.kind === "file" ? p.name === item.name : p.text === item.text)) || null;
  }

  function ingestChat(msg) {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    const item = itemFromMsg(msg);
    const pending = matchPending(item);
    if (pending) {
      const oldId = pending.id;
      Object.assign(pending, { ...item, time: pending.time, status: "sent" });
      delete pending.file;
      db.get(oldId).then((t) => { if (t) { db.put(pending.id, t); db.del(oldId); } });
      save();
      render();
      return;
    }
    thread.push(item);
    save();
    render(item.id);
    if (item.dir === "in" && document.visibilityState === "visible" && navigator.vibrate) navigator.vibrate(10);
  }

  async function bodyOf(msg) {
    if (msg.attachment && msg.attachment.url) {
      const r = await fetch(msg.attachment.url);
      return r.text();
    }
    return msg.message || "";
  }

  async function ingestControl(msg) {
    let data;
    try { data = JSON.parse(await bodyOf(msg)); } catch { return; }
    if (!data || data.from === "phone") return;
    if (data.k === "presence") {
      if (!presence || data.at >= presence.at) {
        presence = { at: data.at, tabs: data.tabs || (presence && presence.tabs) || null, tabsAt: data.tabs ? data.at : presence && presence.tabsAt };
        store.set("presence", presence);
        renderPresence();
        if (!$("sheetTabs").hidden) renderTabs();
      }
    } else if (data.k === "note") {
      if (data.at > note.at) {
        note = { text: data.text || "", at: data.at };
        store.set("note", note);
        if (document.activeElement !== $("noteText")) $("noteText").value = note.text;
        $("noteWhen").textContent = `Edited on your Chromebook ${ago(note.at)}`;
      }
    } else if (data.k === "del" && data.id) {
      removeLocal(data.id);
    }
  }

  function handle(msg) {
    if (!msg || msg.event !== "message") return;
    since = Math.max(since, msg.time);
    store.set("since", since);
    if (msg.topic === CTL) ingestControl(msg);
    else ingestChat(msg);
  }

  function connect() {
    if (source) source.close();
    const s = since ? String(since) : "12h";
    source = new EventSource(`${server}/${CHAT},${CTL}/sse?since=${s}`);
    source.addEventListener("message", (e) => {
      try { handle(JSON.parse(e.data)); } catch {}
    });
    source.onopen = () => hello();
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
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
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
        } else {
          reject(new Error(xhr.status === 413 ? "too-big" : xhr.status === 429 ? "rate" : `HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => { const e = new Error("network"); e.progressed = progressed; reject(e); };
      xhr.send(body);
    });
  }

  async function post(url, body, onProgress) {
    try {
      return await xhrPost(url, body, onProgress);
    } catch (err) {
      if (err.message !== "network" || err.progressed || !onProgress) throw err;
      return xhrPost(url, body, null);
    }
  }

  function postControl(data) {
    const body = JSON.stringify({ ...data, from: "phone" });
    const big = new TextEncoder().encode(body).length > MAX_TEXT_BYTES;
    const url = `${server}/${CTL}?tags=ctl${big ? "&filename=ctl.json" : ""}`;
    return post(url, big ? new Blob([body]) : body).catch(() => {});
  }

  function hello(wantTabs) {
    const now = Date.now();
    if (!wantTabs && now - lastHello < 60000) return;
    lastHello = now;
    postControl({ k: "hello", at: now, want: wantTabs ? "tabs" : undefined });
  }

  function newTmp(extra) {
    const item = { id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: Date.now(), dir: "out", status: "sending", ...extra };
    thread.push(item);
    render(item.id);
    return item;
  }

  function markSent(item, res) {
    item.status = "sent";
    if (res && res.id && !seen.has(res.id)) {
      const oldId = item.id;
      item.id = res.id;
      seen.add(res.id);
      if (res.attachment) {
        item.url = res.attachment.url;
        item.expires = res.attachment.expires ? res.attachment.expires * 1000 : Date.now() + 3 * 36e5;
      }
      db.get(oldId).then((t) => { if (t) { db.put(item.id, t); db.del(oldId); } });
    } else if (res && res.id && seen.has(res.id)) {
      const dup = thread.findIndex((i) => i.id === res.id && i !== item);
      if (dup >= 0) thread.splice(dup, 1);
      item.id = res.id;
    }
    save();
    render();
  }

  function markFailed(item, err) {
    item.status = "failed";
    item.error = err.message === "too-big" ? "Too big · 15 MB max" : err.message === "rate" ? "Too many at once · tap to retry" : "Not sent · tap to retry";
    render();
  }

  async function makeThumb(source, max = 360) {
    try {
      const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.72);
    } catch {
      return null;
    }
  }

  async function shrinkImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { return null; }
    let scale = Math.min(1, Math.sqrt(SHRINK_TARGET / file.size) * 1.1);
    for (let attempt = 0; attempt < 6; attempt++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
      if (blob && blob.size <= SHRINK_TARGET) {
        const base = (file.name || "Photo").replace(/\.[^.]+$/, "");
        return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
      }
      scale *= 0.8;
    }
    return null;
  }

  const queue = [];
  let running = false;

  async function sendFileItem(item) {
    let file = item.file;
    try {
      if (file.size > MAX_FILE) {
        if (isImageName(file.name, file.type)) {
          item.note = "Shrinking to fit…";
          render();
          const smaller = await shrinkImage(file);
          if (!smaller) throw new Error("too-big");
          file = smaller;
          item.name = file.name;
          item.size = file.size;
          item.note = "Resized to fit";
        } else {
          throw new Error("too-big");
        }
      }
      const res = await post(`${server}/${CHAT}?filename=${encodeURIComponent(item.name)}&tags=file,from-phone`, new Blob([file]), (p) => {
        item.progress = p;
        const bar = document.querySelector(`[data-id="${item.id}"] .progress span`);
        if (bar) bar.style.width = `${(p * 100).toFixed(1)}%`;
      });
      delete item.file;
      markSent(item, res);
    } catch (err) {
      markFailed(item, err);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      await job();
    }
    running = false;
  }

  function enqueueFiles(files) {
    for (const f of files) {
      const name = f.name && !/^image\.(jpe?g|png)$/i.test(f.name)
        ? f.name
        : `Photo ${clock(Date.now()).replace(":", ".")}.${(f.type.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
      const item = newTmp({ kind: "file", name, type: f.type, size: f.size, file: f });
      if (isImageName(name, f.type)) {
        makeThumb(f).then((t) => { if (t) { db.put(item.id, t); render(); } });
      }
      queue.push(() => sendFileItem(item));
    }
    run();
  }

  function sendText(text, mode) {
    const t = text.trim();
    if (!t) return;
    const link = isUrl(t);
    const item = newTmp({ kind: link ? "link" : "text", text: t, opened: mode === "open" });
    const tags = mode === "open" ? "open,link,from-phone" : link ? "link,from-phone" : "text,from-phone";
    queue.push(async () => {
      try {
        const bytes = new TextEncoder().encode(t).length;
        const res = bytes <= MAX_TEXT_BYTES
          ? await post(`${server}/${CHAT}?tags=${tags}`, t)
          : await post(`${server}/${CHAT}?filename=${encodeURIComponent("Note.txt")}&tags=file,from-phone`, new Blob([t]));
        markSent(item, res);
      } catch (err) {
        markFailed(item, err);
      }
    });
    run();
  }

  function retry(item) {
    if (item.kind === "file" && item.file) {
      item.status = "sending";
      render();
      queue.push(() => sendFileItem(item));
      run();
    } else if (item.text) {
      removeLocal(item.id);
      sendText(item.text, item.opened ? "open" : null);
    }
  }

  function resend(item) {
    if (item.kind === "file") {
      if (!item.url || item.expires < Date.now()) { toast("That file has expired"); return; }
      const copy = newTmp({ kind: "file", name: item.name, type: item.type, size: item.size });
      db.get(item.id).then((t) => { if (t) db.put(copy.id, t); });
      queue.push(async () => {
        try {
          const res = await post(`${server}/${CHAT}?attach=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(item.name)}&tags=file,from-phone`, "");
          markSent(copy, res);
        } catch (err) {
          markFailed(copy, err);
        }
      });
      run();
    } else {
      sendText(item.text, item.opened ? "open" : null);
    }
  }

  function removeLocal(id) {
    const i = thread.findIndex((x) => x.id === id);
    if (i < 0) return;
    thread.splice(i, 1);
    db.del(id);
    save();
    render();
  }

  const ICON = {
    laptop: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M2 19h20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2H10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    resend: '<svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 0 1 13-5.1M19.5 12a7.5 7.5 0 0 1-13 5.1M17.5 3.5v3.6h-3.6M6.5 20.5v-3.6h3.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l.8 11.2A2 2 0 0 0 9.8 20h4.4a2 2 0 0 0 2-1.8L17 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4.5v11M7.5 11 12 15.5 16.5 11M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function bubbleFor(item) {
    if (item.kind === "file" && isImageName(item.name, item.type)) {
      const b = el("div", "bubble photo");
      const expired = item.expires && item.expires < Date.now();
      db.get(item.id).then((thumb) => {
        if (thumb) {
          const img = el("img");
          img.alt = item.name;
          img.src = thumb;
          b.replaceChildren(img);
        } else if (item.url && !expired) {
          const img = el("img");
          img.alt = item.name;
          img.crossOrigin = "anonymous";
          img.referrerPolicy = "no-referrer";
          img.onload = () => makeThumb(img).then((t) => { if (t) db.put(item.id, t); });
          img.onerror = () => b.replaceChildren(el("div", "gone", "Photo · expired"));
          img.src = item.url;
          b.replaceChildren(img);
        } else {
          b.replaceChildren(el("div", "gone", item.status === "sending" ? "Preparing…" : "Photo · expired"));
        }
      });
      if (item.status === "sending") {
        const p = el("div", "progress");
        const s = el("span");
        s.style.width = `${((item.progress || 0) * 100).toFixed(1)}%`;
        p.append(s);
        b.append(p);
      }
      return b;
    }
    if (item.kind === "file") {
      const b = el("div", "bubble file");
      const ext = extOf(item.name);
      const icon = el("div", `file-icon${ext === "pdf" ? " pdf" : ""}`, (ext || "file").toUpperCase().slice(0, 4));
      const meta = el("div", "file-meta");
      meta.append(el("b", "", item.name));
      const expired = item.expires && item.expires < Date.now();
      meta.append(el("small", "", item.status === "sending" ? (item.note || fmtBytes(item.size)) : expired ? "Expired" : [fmtBytes(item.size), item.note].filter(Boolean).join(" · ") || "Tap to open"));
      b.append(icon, meta);
      if (item.status === "sending") {
        const p = el("div", "progress");
        const s = el("span");
        s.style.width = `${((item.progress || 0) * 100).toFixed(1)}%`;
        p.append(s);
        b.append(p);
      }
      return b;
    }
    if (item.kind === "link") {
      const b = el("div", "bubble link");
      const a = el("a", "", item.text);
      a.href = item.text;
      a.target = "_blank";
      a.rel = "noreferrer";
      b.append(a);
      try { b.append(el("span", "domain", new URL(item.text).hostname.replace(/^www\./, ""))); } catch {}
      return b;
    }
    return el("div", "bubble text", item.text);
  }

  function metaFor(item) {
    const m = el("div", "meta");
    if (item.status === "sending") m.textContent = "Sending…";
    else if (item.status === "failed") { m.classList.add("failed"); m.textContent = item.error || "Not sent"; }
    else {
      m.append(document.createTextNode(clock(item.time)));
      if (item.kind === "link" && item.opened) {
        const o = el("span", "opened");
        o.innerHTML = ICON.laptop;
        o.append(document.createTextNode(item.dir === "out" ? "Opened on Chromebook" : "Opened"));
        m.append(document.createTextNode(" · "), o);
      } else if (item.dir === "in") {
        m.append(document.createTextNode(" · from Chromebook"));
      }
    }
    return m;
  }

  let renderQueued = false;
  let pendingFresh = null;
  function render(freshId) {
    if (freshId) pendingFresh = freshId;
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      const f = pendingFresh;
      pendingFresh = null;
      doRender(f);
    });
  }

  let stick = true;
  const toBottom = () => { const t = $("thread"); t.scrollTop = t.scrollHeight; };
  $("thread").addEventListener("scroll", () => {
    const t = $("thread");
    stick = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  }, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => { if (stick) toBottom(); }).observe($("items"));
    new ResizeObserver(() => { if (stick) toBottom(); }).observe($("thread"));
  }
  $("items").addEventListener("load", () => { if (stick) toBottom(); }, true);

  function doRender(freshId) {
    const box = $("items");
    const threadEl = $("thread");
    if (freshId) stick = true;
    const nearBottom = stick;
    box.replaceChildren();
    $("empty").hidden = thread.length > 0;
    let lastDay = "";
    let lastTime = 0;
    for (const item of thread) {
      const day = dayLabel(item.time);
      if (day !== lastDay || item.time - lastTime > 3 * 36e5) {
        box.append(el("div", "day", `${day} ${clock(item.time)}`));
        lastDay = day;
      }
      lastTime = item.time;
      const row = el("div", `msg ${item.dir}${item.id === freshId ? " fresh" : ""}`);
      row.dataset.id = item.id;
      row.append(bubbleFor(item), metaFor(item));
      box.append(row);
    }
    if (nearBottom || freshId) {
      toBottom();
      requestAnimationFrame(toBottom);
      setTimeout(toBottom, 120);
    }
  }

  function findItem(id) {
    return thread.find((i) => i.id === id);
  }

  let pressTimer = 0;
  let pressed = null;
  let longPressed = false;
  $("items").addEventListener("pointerdown", (e) => {
    const bubble = e.target.closest(".bubble");
    if (!bubble) return;
    longPressed = false;
    pressed = bubble;
    bubble.classList.add("pressed");
    pressTimer = setTimeout(() => {
      longPressed = true;
      bubble.classList.remove("pressed");
      const item = findItem(bubble.closest(".msg").dataset.id);
      if (item) openActions(item);
    }, 430);
  });
  const endPress = () => {
    clearTimeout(pressTimer);
    if (pressed) pressed.classList.remove("pressed");
    pressed = null;
  };
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => $("items").addEventListener(t, endPress));
  $("thread").addEventListener("scroll", endPress, { passive: true });
  $("items").addEventListener("contextmenu", (e) => e.preventDefault());

  $("items").addEventListener("click", (e) => {
    if (longPressed) { e.preventDefault(); longPressed = false; return; }
    const row = e.target.closest(".msg");
    if (!row) return;
    const item = findItem(row.dataset.id);
    if (!item) return;
    if (item.status === "failed") { e.preventDefault(); retry(item); return; }
    if (item.kind === "file" && item.status === "sent") {
      if (item.url && !(item.expires < Date.now())) window.open(item.url, "_blank", "noreferrer");
      else toast("That file has expired");
    } else if (item.kind === "text") {
      openActions(item);
    }
  });

  let sheetOpen = null;
  function openSheet(id) {
    if (sheetOpen) closeSheet(true);
    sheetOpen = $(id);
    $("scrim").hidden = false;
    sheetOpen.classList.remove("closing");
    sheetOpen.hidden = false;
  }
  function closeSheet(instant) {
    const s = sheetOpen;
    if (!s) return;
    sheetOpen = null;
    if (document.activeElement && s.contains(document.activeElement)) document.activeElement.blur();
    if (instant) { s.hidden = true; $("scrim").hidden = true; return; }
    s.classList.add("closing");
    $("scrim").hidden = true;
    setTimeout(() => { s.hidden = true; s.classList.remove("closing"); }, 250);
  }
  $("scrim").addEventListener("click", () => closeSheet());
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet()));

  let startY = null;
  document.querySelectorAll(".grabber").forEach((g) => {
    const sheet = g.closest(".sheet");
    sheet.addEventListener("touchstart", (e) => {
      if (e.target.closest("textarea, .tab-list, .settings-body, .action-list")) { startY = null; return; }
      startY = e.touches[0].clientY;
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener("touchend", (e) => {
      if (startY === null) return;
      const dy = e.changedTouches[0].clientY - startY;
      sheet.style.transform = "";
      startY = null;
      if (dy > 90) closeSheet();
    });
  });

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      toast("Couldn't copy");
    }
  }

  function openActions(item) {
    const list = $("actionList");
    list.replaceChildren();
    const preview = el("div", "action-preview", item.kind === "file" ? item.name : item.text);
    list.append(preview);
    const add = (label, icon, fn, cls) => {
      const b = el("button", cls || "");
      b.type = "button";
      b.append(el("span", "", label));
      const i = el("span");
      i.innerHTML = icon;
      b.append(i.firstChild);
      b.addEventListener("click", () => { closeSheet(); fn(); });
      list.append(b);
    };
    if (item.kind !== "file") add("Copy", ICON.copy, () => copy(item.text));
    if (item.kind === "link") {
      add("Open", ICON.open, () => window.open(item.text, "_blank", "noreferrer"));
      add("Open on Chromebook", ICON.laptop, () => sendText(item.text, "open"));
    }
    if (item.kind === "file" && item.url && !(item.expires < Date.now())) {
      add("Open or save", ICON.save, () => window.open(item.url, "_blank", "noreferrer"));
      add("Copy link", ICON.copy, () => copy(item.url));
    }
    if (item.status === "sent") add(item.dir === "out" ? "Send again" : "Send back", ICON.resend, () => resend(item));
    add("Delete", ICON.trash, () => {
      removeLocal(item.id);
      if (!item.id.startsWith("tmp-")) postControl({ k: "del", id: item.id });
    }, "danger");
    openSheet("actions");
  }

  function renderPresence() {
    const p = $("presence");
    const span = p.querySelector("span");
    if (!presence) {
      p.className = "presence";
      span.textContent = "Chromebook not seen yet";
    } else if (Date.now() - presence.at < ONLINE_MS) {
      p.className = "presence on";
      span.textContent = "Chromebook online";
    } else {
      p.className = "presence off";
      span.textContent = `Chromebook last seen ${ago(presence.at)}`;
    }
  }

  function renderTabs() {
    const ul = $("tabList");
    ul.replaceChildren();
    const tabs = presence && presence.tabs;
    $("tabsWhen").textContent = tabs
      ? `Updated ${ago(presence.tabsAt || presence.at)}`
      : "Asking your Chromebook…";
    if (!tabs) {
      ul.append(el("li", "none", presence && Date.now() - presence.at > ONLINE_MS ? "Your Chromebook seems to be off or asleep. Its tabs appear here when it's back." : "Waiting for your Chromebook to answer…"));
      return;
    }
    if (!tabs.length) {
      ul.append(el("li", "none", "No tabs open on your Chromebook."));
      return;
    }
    tabs.forEach((t) => {
      const li = el("li");
      const a = el("a");
      a.href = t.u;
      a.target = "_blank";
      a.rel = "noreferrer";
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      try { img.src = `https://www.google.com/s2/favicons?sz=64&domain=${new URL(t.u).hostname}`; } catch {}
      const txt = el("div", "t");
      txt.append(el("b", "", t.t || t.u));
      try { txt.append(el("small", "", new URL(t.u).hostname.replace(/^www\./, ""))); } catch {}
      a.append(img, txt);
      li.append(a);
      ul.append(li);
    });
  }

  $("openTabs").addEventListener("click", () => {
    renderTabs();
    openSheet("sheetTabs");
    hello(true);
  });
  $("refreshTabs").addEventListener("click", () => {
    $("tabsWhen").textContent = "Asking your Chromebook…";
    hello(true);
  });

  $("openNote").addEventListener("click", () => {
    $("noteText").value = note.text;
    $("noteWhen").textContent = note.at ? `Last edited ${ago(note.at)}` : "Shared with your new tab";
    openSheet("sheetNote");
  });
  let noteTimer = 0;
  $("noteText").addEventListener("input", () => {
    note = { text: $("noteText").value, at: Date.now() };
    store.set("note", note);
    $("noteWhen").textContent = "Saving…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      await postControl({ k: "note", text: note.text, at: note.at });
      $("noteWhen").textContent = "Saved · syncs to your new tab";
    }, 2500);
  });
  $("copyNote").addEventListener("click", () => {
    if ($("noteText").value.trim()) copy($("noteText").value);
    else toast("Nothing to copy");
  });

  const filesUrl = `${server}/${CHAT}?tags=file,from-phone&filename=`;
  const openUrl = `${server}/${CHAT}?tags=open,link,from-phone`;
  $("urlFiles").textContent = filesUrl;
  $("urlOpen").textContent = openUrl;
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copy($(b.dataset.copy).textContent)));
  $("copyPairing").addEventListener("click", () => copy(`${location.origin}${location.pathname}#t=${topic}${server !== "https://ntfy.sh" ? `&s=${server}` : ""}`));
  $("openSettings").addEventListener("click", () => openSheet("sheetSettings"));

  const BG_TOPS = { aurora: "#0b0f1d", midnight: "#05060c", graphite: "#121214", ocean: "#031420", rose: "#160a14", sunset: "#2a1714" };
  function applyBg(name) {
    const t = BG_TOPS[name] ? name : "aurora";
    document.documentElement.dataset.bg = t;
    $("themeColor").setAttribute("content", BG_TOPS[t]);
    document.querySelectorAll("#themes .theme").forEach((b) => b.classList.toggle("on", b.dataset.bg === t));
    store.set("bg", t);
  }
  $("themes").addEventListener("click", (e) => {
    const b = e.target.closest(".theme");
    if (b) applyBg(b.dataset.bg);
  });
  applyBg(store.get("bg", "aurora"));
  $("clearHistory").addEventListener("click", () => {
    thread = [];
    db.clear();
    save();
    render();
    closeSheet();
    toast("History cleared");
  });

  ["pickPhotos", "pickCamera", "pickFiles"].forEach((id) => {
    $(id).addEventListener("change", (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) enqueueFiles(files);
    });
  });

  $("sendClipboard").addEventListener("click", async () => {
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const imgType = it.types.find((t) => t.startsWith("image/"));
          if (imgType) {
            const blob = await it.getType(imgType);
            enqueueFiles([new File([blob], `Clipboard ${clock(Date.now()).replace(":", ".")}.${imgType.split("/")[1].replace("jpeg", "jpg")}`, { type: imgType })]);
            return;
          }
          if (it.types.includes("text/plain")) {
            const text = await (await it.getType("text/plain")).text();
            if (text.trim()) { sendText(text); return; }
          }
        }
      }
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) sendText(text);
      else toast("Your clipboard is empty");
    } catch {
      toast("Tap Paste when your iPhone asks");
    }
  });

  const ta = $("text");
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
    const v = ta.value.trim();
    $("sendText").disabled = !v;
    $("openOnLaptop").hidden = !isUrl(v);
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("focus", () => { if (stick) setTimeout(toBottom, 300); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendText(ta.value);
    ta.value = "";
    grow();
  });
  $("openOnLaptop").addEventListener("click", () => {
    sendText(ta.value, "open");
    ta.value = "";
    grow();
  });

  addEventListener("paste", (e) => {
    if (e.target === ta || e.target === $("noteText")) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); enqueueFiles(files); }
  });

  $("startScan").addEventListener("click", () => {
    window.DropScanner.start((blob, name) => {
      enqueueFiles([new File([blob], name, { type: "application/pdf" })]);
    }, toast);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!source || source.readyState === EventSource.CLOSED) connect();
    else hello();
    renderPresence();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") { renderPresence(); hello(); }
  }, 30000);

  thread = thread.filter((i) => !i.id.startsWith("tmp-"));
  render();
  renderPresence();
  grow();
  connect();
})();
