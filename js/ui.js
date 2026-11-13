(function () {
  "use strict";

  var PAD = 36;
  var CELL = 64;
  var BW = 584;
  var BH = 648;
  var RECORD_KEY = "fanqi-demo-records-v1";
  var POP = { reveal: 1, capture: 1, win: 1 };

  var state = null;
  var selected = null;
  var legal = [];
  var banned = [];
  var lock = false;
  var session = 0;
  var pieceNodes = new Map();
  var clocks = { red: 0, black: 0, stamp: Date.now() };
  var fxResolve = null;
  var fxTimer = 0;
  var coachTimer = 0;
  var lastCue = "";
  var account = null;
  var remoteRecords = [];
  var booted = false;
  var playMode = "local";
  var seat = null;
  var roomCode = "";
  var socket = null;
  var applyingRemote = false;
  var film = null;
  var filmGen = 0;
  var viewTurn = null;

  function apiBase() {
    var path = location.pathname || "/";
    if (path === "/fanqi" || path.indexOf("/fanqi/") === 0) return "/fanqi";
    return "";
  }

  function api(path) {
    return apiBase() + path;
  }

  function wsUrl() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    return proto + location.host + apiBase() + "/ws";
  }

  var board = document.getElementById("board");
  var piecesLayer = document.getElementById("pieces");
  var pointsLayer = document.getElementById("points");
  var fx = document.getElementById("fx");
  var modal = document.getElementById("modal");

  window.addEventListener("error", function (ev) {
    document.documentElement.dataset.bootError = ev.message || "error";
  });

  function xOf(f) { return ((PAD + f * CELL) / BW) * 100; }
  function yOf(r) { return ((PAD + (9 - r) * CELL) / BH) * 100; }

  function $(id) { return document.getElementById(id); }

  function buildGrid() {
    var svg = $("grid");
    svg.setAttribute("viewBox", "0 0 " + BW + " " + BH);
    var ns = "http://www.w3.org/2000/svg";
    function line(x1, y1, x2, y2, width) {
      var el = document.createElementNS(ns, "line");
      el.setAttribute("x1", x1);
      el.setAttribute("y1", y1);
      el.setAttribute("x2", x2);
      el.setAttribute("y2", y2);
      el.setAttribute("stroke", "#7a3e24");
      el.setAttribute("stroke-width", width || "1.7");
      el.setAttribute("stroke-linecap", "square");
      svg.appendChild(el);
    }
    function X(f) { return PAD + f * CELL; }
    function Y(r) { return PAD + (9 - r) * CELL; }
    var r;
    var f;
    for (r = 0; r <= 9; r++) line(X(0), Y(r), X(8), Y(r));
    line(X(0), Y(9), X(0), Y(0), "2.2");
    line(X(8), Y(9), X(8), Y(0), "2.2");
    for (f = 1; f <= 7; f++) {
      line(X(f), Y(9), X(f), Y(5));
      line(X(f), Y(4), X(f), Y(0));
    }
    line(X(3), Y(0), X(5), Y(2));
    line(X(5), Y(0), X(3), Y(2));
    line(X(3), Y(9), X(5), Y(7));
    line(X(5), Y(9), X(3), Y(7));
  }

  function buildFiles() {
    var red = ["九", "八", "七", "六", "五", "四", "三", "二", "一"];
    var black = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    function fill(id, labels, cls) {
      var row = $(id);
      row.classList.add(cls);
      labels.forEach(function (text, f) {
        var span = document.createElement("span");
        var glyph = document.createElement("i");
        glyph.textContent = text;
        span.appendChild(glyph);
        span.style.left = xOf(f) + "%";
        row.appendChild(span);
      });
    }
    fill("files-black", black, "black");
    fill("files-red", red, "red");
  }

  function buildPoints() {
    for (var r = 0; r < 10; r++) {
      for (var f = 0; f < 9; f++) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "point";
        btn.style.left = xOf(f) + "%";
        btn.style.top = yOf(r) + "%";
        btn.dataset.f = String(f);
        btn.dataset.r = String(r);
        btn.setAttribute("aria-label", "交叉点");
        var mark = document.createElement("i");
        mark.className = "mark";
        btn.appendChild(mark);
        btn.addEventListener("click", onPointClick);
        pointsLayer.appendChild(btn);
      }
    }
  }

  function playSound(kind) {
    if (window.FanqiAudio) FanqiAudio.play(kind);
  }

  function flashCoach(text) {
    var el = $("coach");
    el.textContent = text;
    el.classList.add("warn");
    clearTimeout(coachTimer);
    coachTimer = setTimeout(function () {
      el.classList.remove("warn");
      renderCoach();
    }, 1500);
  }

  function shake() {
    document.body.classList.remove("shake");
    void document.body.offsetWidth;
    document.body.classList.add("shake");
    setTimeout(function () { document.body.classList.remove("shake"); }, 460);
  }

  function closeFx() {
    clearTimeout(fxTimer);
    fx.hidden = true;
    fx.className = "fx";
    var done = fxResolve;
    fxResolve = null;
    if (done) done();
  }

  function showFx(event) {
    return new Promise(function (resolve) {
      fxResolve = resolve;
      fx.hidden = false;
      fx.className = "fx show " + event.type;
      $("fx-title").textContent = event.title || "";
      var sub = $("fx-sub");
      sub.textContent = event.sub || "";
      sub.hidden = !sub.textContent;
      $("fx-actions").hidden = false;
    });
  }

  function present(events, token) {
    var win = null;
    events.forEach(function (event) {
      if (token !== session) return;
      if (event.type === "win") win = event;
      if (event.type === "check") playSound("check");
      else if (POP[event.type]) playSound(event.type === "reveal" ? "flip" : event.type);
    });
    if (!win) return Promise.resolve();
    lock = true;
    return showFx(win).finally(function () {
      if (token === session) lock = false;
    });
  }

  function ask(title, body, okText) {
    return new Promise(function (resolve) {
      if (modal.open) {
        resolve(false);
        return;
      }
      $("modal-title").textContent = title;
      var box = $("modal-body");
      box.replaceChildren();
      box.textContent = body;
      $("modal-ok").textContent = okText || "确定";
      $("modal-cancel").hidden = false;
      function onClose() {
        modal.removeEventListener("close", onClose);
        resolve(modal.returnValue === "ok");
      }
      modal.addEventListener("close", onClose);
      modal.showModal();
    });
  }

  function soon(name) {
    if (modal.open) return;
    $("modal-title").textContent = name;
    var box = $("modal-body");
    box.replaceChildren();
    box.textContent = "这个功能还在后面的版本里。";
    $("modal-ok").textContent = "知道了";
    $("modal-cancel").hidden = true;
    modal.showModal();
  }

  function recordList() {
    var wrap = document.createElement("div");
    wrap.className = "rules";
    var title = document.createElement("h4");
    title.textContent = account && !account.guest ? "我的对局" : "本机对局";
    wrap.appendChild(title);
    var rows = readRecords();
    if (!rows.length) {
      var empty = document.createElement("p");
      empty.textContent = "还没有下完的对局。";
      wrap.appendChild(empty);
      return wrap;
    }
    var list = document.createElement("ul");
    rows.slice(0, 8).forEach(function (rec) {
      var li = document.createElement("li");
      var date = new Date(rec.at);
      var stamp = (date.getMonth() + 1) + "/" + date.getDate() + " " +
        String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
      li.textContent = stamp + "  " + (rec.result || "结束") + "  " + rec.moves + "手";
      list.appendChild(li);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function showRules() {
    if (modal.open) return;
    $("modal-title").textContent = "规则";
    var box = $("modal-body");
    box.replaceChildren();
    box.appendChild($("rules-template").content.cloneNode(true));
    box.appendChild(recordList());
    $("modal-ok").textContent = "知道了";
    $("modal-cancel").hidden = true;
    modal.showModal();
  }

  function fmt(ms) {
    var sec = Math.floor(ms / 1000);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function readRecords() {
    if (account && !account.guest) return remoteRecords.slice();
    try {
      return JSON.parse(localStorage.getItem(RECORD_KEY) || "[]");
    } catch (err) {
      return [];
    }
  }

  function recordPayload() {
    return {
      gameId: state.gameId,
      at: Date.now(),
      winner: state.winner,
      result: state.resultText,
      moves: state.moveCount,
      specials: {},
    };
  }

  function syncRecord() {
    if (!state) return;
    if (account && !account.guest) {
      remoteRecords = remoteRecords.filter(function (item) { return item.gameId !== state.gameId; });
      var saved = state.status === "playing" ? null : recordPayload();
      if (saved) remoteRecords.unshift(saved);
      remoteRecords = remoteRecords.slice(0, 20);
      var path = api("/api/records" + (saved ? "" : "/" + encodeURIComponent(state.gameId)));
      fetch(path, {
        method: saved ? "PUT" : "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: saved ? JSON.stringify(saved) : undefined,
      }).catch(function () {});
      return;
    }
    try {
      var list = readRecords().filter(function (item) { return item.gameId !== state.gameId; });
      if (state.status !== "playing") list.unshift(recordPayload());
      localStorage.setItem(RECORD_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (err) {}
  }

  function isMine(piece) {
    return state.status === "playing" && Jieqi.owns(piece, state.turn);
  }

  function showsMoveRing(piece) {
    if (!isMine(piece)) return false;
    if (!Jieqi.inCheck(state, state.turn)) return true;
    for (var i = 0; i < legal.length; i++) {
      if (legal[i].f === piece.f && legal[i].r === piece.r) return true;
    }
    return false;
  }

  function destAt(f, r) {
    if (!selected) return null;
    for (var i = 0; i < legal.length; i++) {
      var mv = legal[i];
      if (mv.f === selected.f && mv.r === selected.r && mv.tf === f && mv.tr === r) return mv;
    }
    return null;
  }

  function banAt(f, r) {
    if (!selected) return null;
    for (var i = 0; i < banned.length; i++) {
      var mv = banned[i];
      if (mv.f === selected.f && mv.r === selected.r && mv.tf === f && mv.tr === r) return mv;
    }
    return null;
  }

  function clearGhosts() {
    piecesLayer.querySelectorAll(".ghost").forEach(function (node) { node.remove(); });
  }

  function renderPieces() {
    clearGhosts();
    var alive = new Set();
    var checked = !film && state.status === "playing" && Jieqi.inCheck(state, state.turn);
    Object.keys(state.pieces).forEach(function (id) {
      var piece = state.pieces[id];
      if (!piece.alive) return;
      alive.add(id);
      var node = pieceNodes.get(id);
      if (!node) {
        node = document.createElement("button");
        node.type = "button";
        node.className = "piece down";
        node.dataset.id = id;
        var disk = document.createElement("span");
        disk.className = "piece-disk";
        var back = document.createElement("span");
        back.className = "face back";
        back.textContent = "棋";
        back.setAttribute("aria-hidden", "true");
        var front = document.createElement("span");
        front.className = "face front";
        front.setAttribute("aria-hidden", "true");
        var glyph = document.createElement("b");
        front.appendChild(glyph);
        disk.appendChild(back);
        disk.appendChild(front);
        node.appendChild(disk);
        node.addEventListener("click", onPieceClick);
        pieceNodes.set(id, node);
        piecesLayer.appendChild(node);
      }
      var atF = piece.f;
      var atR = piece.r;
      var faceUp = piece.face === "up";
      var driving = film && film.id === id && film.driving;
      if (film && film.id === id && !film.driving) {
        atF = film.fromF;
        atR = film.fromR;
        if (film.wasDown) faceUp = false;
      }
      if (!driving) {
      node.style.left = xOf(atF) + "%";
      node.style.top = yOf(atR) + "%";
      node.className = "piece " + (faceUp ? "up" : "down");
      if (showsMoveRing(piece)) node.classList.add("mine");
      if (selected && selected.f === piece.f && selected.r === piece.r) node.classList.add("selected");
      if (state.lastMove && state.lastMove.tf === piece.f && state.lastMove.tr === piece.r) node.classList.add("last");
      if (checked && piece.face === "up" && piece.type === "general" && piece.color === state.turn) {
        node.classList.add("checked");
      }
      var blocked = banAt(piece.f, piece.r);
      var flag = node.querySelector(".illegal");
      if (blocked) {
        if (!flag) {
          flag = document.createElement("span");
          flag.className = "illegal";
          node.appendChild(flag);
        }
        flag.textContent = blocked.reason === "fly" ? "飞" : "将";
        flag.hidden = false;
      } else if (flag) {
        flag.hidden = true;
      }
      }
      var frontFace = node.querySelector(".front");
      var revealed = piece.face === "up";
      frontFace.classList.toggle("red", revealed && piece.color === "red");
      frontFace.classList.toggle("black", revealed && piece.color === "black");
      node.querySelector("b").textContent = revealed ? Jieqi.GLYPH[piece.color][piece.type] : "";
      node.setAttribute("aria-label", Jieqi.publicName(piece));
    });
    Array.from(pieceNodes.keys()).forEach(function (id) {
      if (!alive.has(id)) {
        pieceNodes.get(id).remove();
        pieceNodes.delete(id);
      }
    });
  }

  function renderPoints() {
    var buttons = pointsLayer.children;
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var f = Number(btn.dataset.f);
      var r = Number(btn.dataset.r);
      btn.className = "point";
      if (film && film.fromF === f && film.fromR === r) btn.classList.add("from");
      else if (state.lastMove && state.lastMove.f === f && state.lastMove.r === r) btn.classList.add("from");
      if (film && film.toF === f && film.toR === r) btn.classList.add("to");
      else if (state.lastMove && state.lastMove.tf === f && state.lastMove.tr === r) btn.classList.add("last");
      var dest = destAt(f, r);
      if (dest) btn.classList.add(dest.risk ? "risk" : dest.capture ? "capture" : "move");
      var ban = banAt(f, r);
      if (ban) btn.classList.add(ban.reason === "fly" ? "fly" : "ban");
    }
  }

  function mini(piece) {
    var el = document.createElement("span");
    el.className = "mini " + piece.color;
    el.textContent = Jieqi.GLYPH[piece.color][piece.type];
    el.title = Jieqi.publicName(piece);
    return el;
  }

  function kindsFor(piece) {
    var quiet = false;
    var eat = false;
    var risk = false;
    legal.forEach(function (mv) {
      if (mv.f !== piece.f || mv.r !== piece.r) return;
      if (!mv.capture) quiet = true;
      else if (mv.risk) risk = true;
      else eat = true;
    });
    return { quiet: quiet, eat: eat, risk: risk };
  }

  function dotHint(kinds) {
    var parts = [];
    if (kinds.quiet) parts.push("绿点落空");
    if (kinds.eat) parts.push("红圈吃子");
    if (kinds.risk) parts.push("黄圈吃暗子");
    return parts.length ? "点" + parts.join("，") + "。" : "这枚棋现在没有合法走法。";
  }

  function banText(reason) {
    if (reason === "fly") return "不能飞将。";
    if (reason === "escape") return "被将军，必须先应将。";
    return "不能送将。";
  }

  function banHint(piece) {
    var fly = false;
    var send = false;
    var escape = false;
    banned.forEach(function (mv) {
      if (mv.f !== piece.f || mv.r !== piece.r) return;
      if (mv.reason === "fly") fly = true;
      else if (mv.reason === "escape") escape = true;
      else send = true;
    });
    if (escape) return "被将军时，标「将」的格子解不开，点下去不会走成。";
    if (fly && send) return "标「飞」是飞将，标「将」是送将，点下去不会走成。";
    if (fly) return "标「飞」的格子是飞将，点下去不会走成。";
    if (send) return "标「将」的格子会送将，点下去不会走成。";
    return "";
  }

  function actionHint() {
    if (state.status !== "playing") return "点重开再洗一盘。";
    if (playMode === "online" && seat && state.turn !== seat) return "等待对方走棋。";
    var check = Jieqi.inCheck(state, state.turn);
    if (!selected) {
      if (check) return "只能走能解开这一将的棋。";
      return "点一枚绿圈的棋。";
    }
    var piece = Jieqi.pieceAt(state, selected.f, selected.r);
    if (!piece) return "点一枚绿圈的棋。";
    var hint = dotHint(kindsFor(piece));
    var blocked = banHint(piece);
    var head = check ? "这一步必须解开。" : "";
    if (piece.face === "down") return head + "暗子按脚下原来的棋种走，落地才翻面。" + hint + blocked;
    return head + Jieqi.publicName(piece) + "。" + hint + blocked;
  }

  function brief(events) {
    var rank = ["win", "capture", "reveal"];
    var found = null;
    rank.forEach(function (type) {
      if (found) return;
      events.forEach(function (event) {
        if (event.type === type) found = event;
      });
    });
    if (!found || found.type === "check") return "";
    if (found.type === "win") return (found.sub || "").replace(/。$/, "");
    if (found.type === "reveal") {
      var match = /是([^。]+)/.exec(found.sub || "");
      return match ? "翻出" + match[1] : "揭开";
    }
    if (found.type === "capture") return "吃子";
    return found.title;
  }

  function renderTurn() {
    var banner = $("turn-banner");
    var seatEl = $("turn-seat");
    if (!state) {
      banner.className = "turn-banner";
      banner.textContent = "";
      seatEl.hidden = true;
      return;
    }
    banner.className = "turn-banner";
    if (!viewTurn && state.status !== "playing") {
      banner.textContent = state.resultText || "对局结束";
    } else if (!viewTurn && Jieqi.inCheck(state, state.turn)) {
      banner.classList.add(state.turn, "warn");
      banner.textContent = Jieqi.sideName(state.turn) + "被将军";
    } else {
      var shown = viewTurn || state.turn;
      banner.classList.add(shown);
      banner.textContent = Jieqi.sideName(shown) + "的回合";
    }
    if (playMode === "online" && seat) {
      seatEl.hidden = false;
      seatEl.textContent = "你执" + (seat === "red" ? "红" : "黑");
    } else {
      seatEl.hidden = true;
    }
  }

  function renderCoach() {
    var el = $("coach");
    var checked = !!(state && state.status === "playing" && Jieqi.inCheck(state, state.turn));
    el.classList.toggle("warn", checked);
    var text = actionHint();
    if (lastCue && !selected) text = lastCue + "。" + text;
    el.textContent = text;
  }

  function renderPlate(color) {
    var root = $("plate-" + color);
    var active = state.status === "playing" && state.turn === color;
    root.className = "side " + color + (active ? " active" : "");
    root.replaceChildren();
    var name = document.createElement("span");
    name.className = "name";
    name.textContent = color === "red" ? "红方" : "黑方";
    var clock = document.createElement("span");
    clock.className = "clock";
    clock.id = "clock-" + color;
    clock.textContent = fmt(clocks[color]);
    root.appendChild(name);
    root.appendChild(clock);
    var dead = state.captured.map(function (id) { return state.pieces[id]; }).filter(function (piece) {
      return piece && piece.color === color;
    });
    if (!dead.length) return;
    var row = document.createElement("span");
    row.className = "minis";
    dead.forEach(function (piece) { row.appendChild(mini(piece)); });
    root.appendChild(row);
  }

  function renderStatus() {
    var canUndo = !!(state.undo && state.undo.length);
    if (playMode === "online") canUndo = canUndo && !!seat && state.turn !== seat;
    $("btn-undo").disabled = !canUndo;
    $("btn-resign").disabled = state.status !== "playing" || (playMode === "online" && state.turn !== seat);
    renderTurn();
    renderCoach();
  }

  function render(animated) {
    var frame = document.querySelector(".board-frame");
    if (!animated) frame.classList.add("instant");
    var boardSide = viewTurn || (state && state.turn);
    var turned = playMode === "online" ? seat === "black" : boardSide === "black";
    frame.classList.toggle("turned", turned);
    if (!animated) board.classList.add("no-anim");
    var hints = !film && state.status === "playing" && Jieqi.moveHints
      ? Jieqi.moveHints(state, state.turn)
      : { legal: [], banned: [] };
    legal = hints.legal;
    banned = hints.banned;
    renderPieces();
    renderPoints();
    renderPlate("red");
    renderPlate("black");
    renderStatus();
    if (!animated) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          board.classList.remove("no-anim");
          frame.classList.remove("instant");
        });
      });
    }
  }

  function refreshSelection() {
    renderPieces();
    renderPoints();
    renderCoach();
  }

  function flash(f, r) {
    var btn = pointsLayer.querySelector('[data-f="' + f + '"][data-r="' + r + '"]');
    if (!btn) return;
    btn.classList.add("impact");
    setTimeout(function () { btn.classList.remove("impact"); }, 360);
  }

  function onPieceClick(ev) {
    var id = ev.currentTarget.dataset.id;
    var piece = state.pieces[id];
    if (!piece || lock) return;
    if (window.FanqiAudio) FanqiAudio.unlock();
    if (playMode === "online" && seat && state.turn !== seat) {
      if (state.status === "playing") flashCoach("等待对方走棋。");
      return;
    }
    if (state.status !== "playing") {
      flashCoach((state.resultText || "对局已经结束") + "。点重开再洗一盘。");
      return;
    }
    var dest = destAt(piece.f, piece.r);
    if (dest) {
      doMove(dest);
      return;
    }
    var blocked = banAt(piece.f, piece.r);
    if (blocked) {
      flashCoach(banText(blocked.reason));
      playSound("bad");
      return;
    }
    if (!Jieqi.owns(piece, state.turn)) {
      flashCoach(piece.face === "down" ? "这枚暗子不归你走。点绿圈的棋。" : "这是对方的棋。点绿圈的棋。");
      playSound("bad");
      return;
    }
    var mine = legal.some(function (mv) { return mv.f === piece.f && mv.r === piece.r; });
    if (!mine) {
      flashCoach(Jieqi.inCheck(state, state.turn) ? "被将军，必须先应将。这枚棋解不开。" : "这枚棋没有合法走法。换一枚绿圈的。");
      playSound("bad");
      selected = null;
    } else if (selected && selected.f === piece.f && selected.r === piece.r) {
      selected = null;
      lastCue = "";
    } else {
      selected = { f: piece.f, r: piece.r };
      lastCue = "";
      playSound("select");
    }
    refreshSelection();
  }

  function onPointClick(ev) {
    if (lock) return;
    if (window.FanqiAudio) FanqiAudio.unlock();
    if (playMode === "online" && seat && state.turn !== seat) {
      if (state.status === "playing") flashCoach("等待对方走棋。");
      return;
    }
    var f = Number(ev.currentTarget.dataset.f);
    var r = Number(ev.currentTarget.dataset.r);
    var dest = destAt(f, r);
    if (dest) {
      doMove(dest);
      return;
    }
    var ban = banAt(f, r);
    if (ban) {
      flashCoach(banText(ban.reason));
      playSound("bad");
      return;
    }
    if (!selected) return;
    selected = null;
    lastCue = "";
    refreshSelection();
  }

  function eatSound(events) {
    for (var j = 0; j < events.length; j++) {
      if (events[j].type === "capture") return "capture";
    }
    return "capture";
  }

  function settleAfterFilm(events, token) {
    if (film) {
      var moverNode = pieceNodes.get(film.id);
      if (moverNode) {
        moverNode.style.transition = "";
        moverNode.style.transform = "";
        moverNode.classList.remove("traveling", "landed");
      }
    }
    film = null;
    viewTurn = null;
    clearGhosts();
    if (token !== session) return;
    render(true);
    var win = null;
    events.forEach(function (event) {
      if (event.type === "win") win = event;
      if (event.type === "check") playSound("check");
    });
    if (!win) {
      lock = false;
      return;
    }
    showFx(win).finally(function () {
      if (token === session) lock = false;
    });
  }

  function later(ms, fn) {
    setTimeout(fn, ms);
  }

  function slidePiece(node, fromF, fromR, toF, toR, ms, done) {
    var x0 = xOf(fromF);
    var y0 = yOf(fromR);
    var x1 = xOf(toF);
    var y1 = yOf(toR);
    var t0 = 0;
    node.style.transition = "none";
    node.style.left = x0 + "%";
    node.style.top = y0 + "%";
    node.classList.add("traveling");
    function frame(now) {
      if (!t0) t0 = now;
      var p = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
      var ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      var lift = Math.sin(Math.PI * p) * 14;
      node.style.left = (x0 + (x1 - x0) * ease) + "%";
      node.style.top = (y0 + (y1 - y0) * ease) + "%";
      node.style.transform = "translate(-50%, calc(-50% - " + lift.toFixed(2) + "px)) scale(" + (1 + Math.sin(Math.PI * p) * 0.08).toFixed(3) + ")";
      if (p < 1) requestAnimationFrame(frame);
      else {
        node.style.left = x1 + "%";
        node.style.top = y1 + "%";
        node.style.transform = "";
        node.classList.remove("traveling");
        node.classList.add("landed");
        done();
      }
    }
    requestAnimationFrame(frame);
  }

  function flipDisk(node, ms, done) {
    var disk = node.querySelector(".piece-disk");
    var turned = document.querySelector(".board-frame").classList.contains("turned");
    var spin = turned ? "rotate(-180deg) " : "";
    node.classList.remove("down");
    node.classList.add("up");
    if (!disk) {
      done();
      return;
    }
    var anim = disk.animate([
      { transform: spin + "rotateY(180deg)" },
      { transform: spin + "rotateY(0deg)" },
    ], { duration: ms, easing: "cubic-bezier(0.16, 0.82, 0.28, 1)", fill: "forwards" });
    anim.onfinish = function () {
      anim.cancel();
      done();
    };
  }

  function popGhost(ghost, ms, done) {
    var anim = ghost.animate([
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
      { transform: "translate(-50%, -72%) scale(1.14)", opacity: 1, offset: 0.32 },
      { transform: "translate(-50%, -30%) scale(0.16)", opacity: 0 },
    ], { duration: ms, easing: "ease", fill: "forwards" });
    anim.onfinish = function () { done(); };
  }

  function playFilm(spec) {
    var token = spec.token;
    var gen = ++filmGen;
    function ok() { return gen === filmGen && token === session; }
    film = {
      id: spec.id,
      fromF: spec.fromF,
      fromR: spec.fromR,
      toF: spec.toF,
      toR: spec.toR,
      phase: "go",
      wasDown: spec.wasDown,
      driving: false,
    };
    viewTurn = spec.actor;
    lock = true;
    var ghost = null;
    if (spec.victimId) {
      var src = pieceNodes.get(spec.victimId);
      if (src) {
        ghost = src.cloneNode(true);
        ghost.classList.add("ghost");
        ghost.style.pointerEvents = "none";
      }
    }
    render(true);
    film.driving = true;
    if (ghost) piecesLayer.appendChild(ghost);
    var node = pieceNodes.get(spec.id);
    if (!ok() || !node) {
      settleAfterFilm(spec.events, token);
      return;
    }
    playSound("move");
    slidePiece(node, spec.fromF, spec.fromR, spec.toF, spec.toR, 520, function () {
      if (!ok()) return;
      flash(spec.toF, spec.toR);
      later(180, function () {
        if (!ok()) return;
        function afterReveal() {
          if (!ok()) return;
          function afterEat() {
            if (!ok()) return;
            later(420, function () {
              if (!ok()) return;
              settleAfterFilm(spec.events, token);
            });
          }
          if (!ghost) {
            afterEat();
            return;
          }
          playSound(eatSound(spec.events));
          popGhost(ghost, 480, afterEat);
        }
        if (!spec.wasDown) {
          later(80, afterReveal);
          return;
        }
        playSound("flip");
        flipDisk(node, 620, function () {
          if (!ok()) return;
          later(860, afterReveal);
        });
      });
    });
  }

  function doMove(mv) {
    var token = session;
    var actor = state.turn;
    var mover = Jieqi.pieceAt(state, mv.f, mv.r);
    var victim = Jieqi.pieceAt(state, mv.tf, mv.tr);
    var wasDown = !!(mover && mover.face === "down");
    var result = Jieqi.move(state, mv.f, mv.r, mv.tf, mv.tr);
    if (!result.ok) {
      flashCoach(result.error || "不能这么走");
      playSound("bad");
      return;
    }
    selected = null;
    lastCue = brief(result.events);
    if (playMode === "online" && !applyingRemote) {
      sendWs({ type: "move", f: mv.f, r: mv.r, tf: mv.tf, tr: mv.tr });
    }
    syncRecord();
    if (!mover) {
      settleAfterFilm(result.events, token);
      return;
    }
    playFilm({
      token: token,
      actor: actor,
      id: mover.id,
      fromF: mv.f,
      fromR: mv.r,
      toF: mv.tf,
      toR: mv.tr,
      wasDown: wasDown,
      victimId: victim ? victim.id : "",
      events: result.events,
    });
  }

  function showTable(show) {
    document.querySelector(".board-frame").hidden = !show;
    document.querySelector(".dock").hidden = !show;
    $("scoreboard").hidden = !show;
    $("coach").hidden = !show;
    $("lobby").hidden = show || playMode !== "online";
    var online = playMode === "online";
    $("app").classList.toggle("mode-online", online);
    $("chat").hidden = !online;
  }

  function startGame() {
    session += 1;
    filmGen += 1;
    film = null;
    viewTurn = null;
    closeFx();
    lock = false;
    selected = null;
    lastCue = "";
    clearTimeout(coachTimer);
    $("coach").classList.remove("warn");
    clocks = { red: 0, black: 0, stamp: Date.now() };
    pieceNodes.forEach(function (node) { node.remove(); });
    pieceNodes.clear();
    state = Jieqi.createGame();
    showTable(true);
    syncRecord();
    render(false);
  }

  function beginOnline(seed) {
    session += 1;
    filmGen += 1;
    film = null;
    viewTurn = null;
    closeFx();
    lock = false;
    selected = null;
    lastCue = "";
    clearTimeout(coachTimer);
    $("coach").classList.remove("warn");
    clocks = { red: 0, black: 0, stamp: Date.now() };
    pieceNodes.forEach(function (node) { node.remove(); });
    pieceNodes.clear();
    state = Jieqi.createGame({
      rng: Jieqi.makeRng(seed >>> 0),
      gameId: "online-" + roomCode + "-" + (seed >>> 0),
    });
    showTable(true);
    render(false);
  }

  function onUndo() {
    if (lock || !state) return;
    if (playMode === "online" && !applyingRemote && (!seat || state.turn === seat)) {
      flashCoach("只能悔自己刚走的一步。");
      return;
    }
    if (!Jieqi.undo(state)) {
      if (!applyingRemote) flashCoach("没有可以悔的棋。");
      return;
    }
    selected = null;
    lastCue = "";
    closeFx();
    render(true);
    if (playMode === "online" && !applyingRemote) sendWs({ type: "undo" });
    syncRecord();
  }

  function finishResign() {
    var token = session;
    var result = Jieqi.resign(state);
    if (!result.ok) return;
    selected = null;
    render(true);
    syncRecord();
    present(result.events, token);
  }

  function onResign() {
    if (lock || !state || state.status !== "playing") return;
    if (playMode === "online" && !applyingRemote && state.turn !== seat) {
      flashCoach("轮到你走时再认输。");
      return;
    }
    ask("认输", Jieqi.sideName(state.turn) + "确定认输？", "认输").then(function (ok) {
      if (!ok || state.status !== "playing") return;
      finishResign();
      if (playMode === "online") sendWs({ type: "resign" });
    });
  }

  function requestRestart() {
    if (playMode === "online") {
      if (!socket || socket.readyState !== 1 || !seat) {
        flashCoach("还没有连上对方。");
        return;
      }
      sendWs({ type: "restart" });
      return;
    }
    startGame();
  }

  function onNew() {
    if (lock || !state) return;
    if (state.moveCount > 0 && state.status === "playing") {
      ask("重开", "这一局还没下完，要重新洗棋吗？", "重开").then(function (ok) {
        if (ok) requestRestart();
      });
      return;
    }
    requestRestart();
  }

  function tick() {
    var now = Date.now();
    if (state && state.status === "playing") clocks[state.turn] += now - clocks.stamp;
    clocks.stamp = now;
    ["red", "black"].forEach(function (color) {
      var el = $("clock-" + color);
      if (el) el.textContent = fmt(clocks[color]);
    });
  }

  function markMode(mode) {
    document.querySelectorAll(".nav-btn[data-mode]").forEach(function (btn) {
      var on = btn.dataset.mode === mode;
      btn.classList.toggle("active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
  }

  function clearChat() {
    $("chat-log").replaceChildren();
  }

  function appendChat(name, text, mine, system) {
    var log = $("chat-log");
    var line = document.createElement("p");
    line.className = "chat-line" + (mine ? " mine" : "") + (system ? " system" : "");
    if (!system) {
      var who = document.createElement("b");
      who.textContent = name;
      line.appendChild(who);
    }
    line.appendChild(document.createTextNode(system ? text : text));
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function chatName() {
    return account && !account.guest ? account.username : "游客";
  }

  function chatLabel(role, name) {
    return (role === "red" ? "红方" : "黑方") + " · " + (name || "游客");
  }

  function sendChat(text) {
    text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) return;
    if (!socket || socket.readyState !== 1 || !seat) {
      appendChat("", "还没有连上对方。", false, true);
      return;
    }
    sendWs({ type: "chat", text: text, name: chatName() });
    appendChat(chatLabel(seat, chatName()), text, true, false);
  }

  function sendWs(obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  function closeSocket() {
    var ws = socket;
    socket = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    try { ws.close(); } catch (err) {}
  }

  function showRoomForms(show) {
    document.querySelectorAll(".lobby-actions").forEach(function (row) {
      row.hidden = !show;
    });
  }

  function onWsMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (err) { return; }
    if (!msg || playMode !== "online") return;
    if (msg.type === "room") {
      seat = msg.role;
      roomCode = msg.code || "";
      $("room-code").textContent = roomCode;
      $("room-verify").textContent = msg.verify || "";
      $("room-pair").hidden = false;
      showRoomForms(false);
      $("lobby-status").textContent = "验证码是 " + (msg.verify || "") + "。和房间号一起发给对方。";
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.querySelector(".stage").scrollTop = 0;
      clearChat();
      appendChat("", "房间号 " + roomCode + "，验证码 " + (msg.verify || "") + "。发给对方后才能进入。", false, true);
      showTable(false);
      return;
    }
    if (msg.type === "chat") {
      appendChat(chatLabel(msg.role, msg.name), msg.text || "", false, false);
      return;
    }
    if (msg.type === "start" || msg.type === "restart") {
      seat = msg.role || seat;
      roomCode = msg.code || roomCode;
      beginOnline(msg.seed);
      return;
    }
    if (msg.type === "move") {
      applyingRemote = true;
      try { doMove(msg); } finally { applyingRemote = false; }
      return;
    }
    if (msg.type === "undo") {
      applyingRemote = true;
      try { onUndo(); } finally { applyingRemote = false; }
      return;
    }
    if (msg.type === "resign") {
      if (!state || state.status !== "playing") return;
      if (msg.role && state.turn !== msg.role) return;
      applyingRemote = true;
      try { finishResign(); } finally { applyingRemote = false; }
      return;
    }
    if (msg.type === "peer-left") {
      seat = null;
      roomCode = "";
      $("room-code").textContent = "";
      $("room-verify").textContent = "";
      $("room-pair").hidden = true;
      showRoomForms(true);
      $("lobby-status").textContent = "对方离开了房间。可以重新开房或加入。";
      appendChat("", "对方离开了房间。", false, true);
      showTable(false);
      return;
    }
    if (msg.type === "error") {
      var text = msg.error || "联机没有成功";
      if (!$("lobby").hidden) $("lobby-status").textContent = text;
      else flashCoach(text);
    }
  }

  function ensureOnlineSocket() {
    if (fileGate()) {
      $("lobby-status").textContent = "联机要先打开 http://127.0.0.1:8787/ 。";
      return Promise.reject();
    }
    if (socket && socket.readyState === 1) return Promise.resolve();
    closeSocket();
    return new Promise(function (resolve, reject) {
      var ws;
      try {
        ws = new WebSocket(wsUrl());
      } catch (err) {
        reject(err);
        return;
      }
      var opened = false;
      socket = ws;
      ws.onmessage = onWsMessage;
      ws.onopen = function () {
        opened = true;
        resolve();
      };
      ws.onclose = function () {
        if (socket !== ws) return;
        socket = null;
        seat = null;
        if (!opened) {
          reject();
          return;
        }
        if (playMode === "online") {
          $("room-code").textContent = "";
          $("room-verify").textContent = "";
          $("room-pair").hidden = true;
          showRoomForms(true);
          $("lobby-status").textContent = "连接断了。可以重新开房或加入。";
          showTable(false);
        }
      };
    });
  }

  function enterOnline() {
    closeSocket();
    playMode = "online";
    seat = null;
    roomCode = "";
    markMode("online");
    closeFx();
    $("room-code").textContent = "";
    $("room-verify").textContent = "";
    $("room-pair").hidden = true;
    showRoomForms(true);
    $("host-code").value = "";
    $("join-code").value = "";
    $("join-verify").value = "";
    $("lobby-status").textContent = "自己起一个房间号，比如 K7MP，然后点开房。验证码会写在这里。";
    clearChat();
    appendChat("", "开房或加入之后，可以在这里发消息。", false, true);
    showTable(false);
  }

  function bind() {
    $("btn-undo").addEventListener("click", onUndo);
    $("btn-resign").addEventListener("click", onResign);
    $("btn-new").addEventListener("click", onNew);
    $("btn-rules").addEventListener("click", showRules);
    $("btn-sound").addEventListener("click", function () {
      var next = window.FanqiAudio ? !FanqiAudio.isEnabled() : true;
      if (window.FanqiAudio) {
        FanqiAudio.setEnabled(next);
        if (next) FanqiAudio.unlock();
      }
      this.textContent = next ? "声音" : "静音";
      this.setAttribute("aria-pressed", next ? "true" : "false");
    });
    $("fx-close").addEventListener("click", closeFx);
    $("fx-again").addEventListener("click", function () {
      requestRestart();
    });
    fx.addEventListener("click", function (ev) {
      if (ev.target !== fx) return;
      if (!$("fx-actions").hidden) return;
      closeFx();
    });
    document.querySelectorAll(".nav-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.dataset.mode;
        if (!mode) return;
        if (mode === "ai" || mode === "rank") {
          soon(mode === "ai" ? "人机对弈" : "对弈排名");
          return;
        }
        if (mode === playMode) return;
        if (mode === "local") {
          closeSocket();
          playMode = "local";
          seat = null;
          markMode("local");
          startGame();
          return;
        }
        enterOnline();
      });
    });
    ["😀", "😂", "😍", "👍", "👏", "🔥", "❤️", "🤔", "😎", "🎉", "😭", "🤝", "💪", "👀", "😅", "♟️"].forEach(function (emo) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = emo;
      btn.addEventListener("click", function () {
        var input = $("chat-input");
        input.value = (input.value + emo).slice(0, 80);
        input.focus();
      });
      $("emoji-bar").appendChild(btn);
    });
    $("btn-host").addEventListener("click", function () {
      var code = $("host-code").value.trim().toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code) || /[01IO]/.test(code)) {
        $("lobby-status").textContent = "房间号换成 4 个字母或数字，避开 0、1、I、O。";
        return;
      }
      ensureOnlineSocket().then(function () {
        sendWs({ type: "create", code: code });
      }).catch(function () {
        $("lobby-status").textContent = "连不上对局服务。";
      });
    });
    $("btn-join").addEventListener("click", function () {
      var code = $("join-code").value.trim().toUpperCase();
      var verify = $("join-verify").value.trim().toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code) || /[01IO]/.test(code)) {
        $("lobby-status").textContent = "房间号换成 4 个字母或数字，避开 0、1、I、O。";
        return;
      }
      if (!/^[A-Z2-9]{4}$/.test(verify) || /[01IO]/.test(verify)) {
        $("lobby-status").textContent = "验证码填开房时显示的那一串。";
        return;
      }
      ensureOnlineSocket().then(function () {
        sendWs({ type: "join", code: code, verify: verify });
      }).catch(function () {
        $("lobby-status").textContent = "连不上对局服务。";
      });
    });
    $("chat-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = $("chat-input");
      sendChat(input.value);
      input.value = "";
    });
    document.addEventListener("keydown", function (ev) {
      var typing = ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA");
      if (typing) return;
      if (document.querySelector("dialog[open]") || !fx.hidden) return;
      if (ev.key === "Escape") {
        selected = null;
        refreshSelection();
      } else if (!lock && (ev.key === "u" || ev.key === "U")) {
        onUndo();
      }
    });
    $("btn-logout").addEventListener("click", leaveApp);
    document.addEventListener("pointerdown", function () {
      if (window.FanqiAudio) FanqiAudio.unlock();
    });
  }

  function gateError(text) {
    $("gate-error").textContent = text || "";
  }

  function fileGate() {
    return location.protocol === "file:";
  }

  function enterApp(next) {
    account = next;
    $("gate").hidden = true;
    $("app").hidden = false;
    $("account-name").hidden = false;
    $("account-name").textContent = next.guest ? "游客" : next.username;
    $("btn-logout").hidden = false;
    if (!booted) {
      booted = true;
      buildGrid();
      buildFiles();
      buildPoints();
      bind();
      setInterval(tick, 500);
    }
    var pending = next.guest
      ? Promise.resolve()
      : fetch(api("/api/records"), { credentials: "same-origin" })
        .then(function (res) { return res.json(); })
        .then(function (body) { remoteRecords = body.records || []; });
    pending.then(function () {
      startGame();
      document.documentElement.dataset.ready = "1";
    }).catch(function () {
      remoteRecords = [];
      startGame();
      document.documentElement.dataset.ready = "1";
    });
  }

  function leaveApp() {
    if (account && !account.guest) {
      fetch(api("/api/logout"), { method: "POST", credentials: "same-origin" }).catch(function () {});
    }
    closeSocket();
    playMode = "local";
    seat = null;
    markMode("local");
    $("app").classList.remove("mode-online");
    $("chat").hidden = true;
    account = null;
    remoteRecords = [];
    closeFx();
    if (modal.open) modal.close();
    $("app").hidden = true;
    $("gate").hidden = false;
    $("btn-logout").hidden = true;
    $("account-name").hidden = true;
    document.documentElement.dataset.ready = "0";
  }

  function submitAccount(path) {
    if (fileGate()) {
      gateError("注册和登录要打开 http://127.0.0.1:8787/ 。先双击 start-fanqi.bat，或运行 python server.py。");
      return;
    }
    var username = $("gate-user").value.trim();
    var password = $("gate-pass").value;
    gateError("");
    fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) {
        gateError(result.body.error || "没有登录成功");
        return;
      }
      enterApp({ guest: false, username: result.body.username });
    }).catch(function () {
      gateError("连不上本机服务。先双击 start-fanqi.bat，或运行 python server.py。");
    });
  }

  if (!window.Jieqi) {
    document.documentElement.dataset.bootError = "引擎没有载入";
    return;
  }
  if (fileGate()) {
    $("gate-lead").textContent = "现在是直接打开的页面。游客可以下，对局只留在这台浏览器。注册登录请先运行 start-fanqi.bat，再打开 http://127.0.0.1:8787/ 。";
  }
  $("gate-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    submitAccount(api("/api/login"));
  });
  $("gate-register").addEventListener("click", function () {
    submitAccount(api("/api/register"));
  });
  $("gate-guest").addEventListener("click", function () {
    gateError("");
    enterApp({ guest: true });
  });
  if (!fileGate()) {
    fetch(api("/api/me"), { credentials: "same-origin" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (body) {
      if (body && body.username) enterApp({ guest: false, username: body.username });
    }).catch(function () {});
  }
})();
