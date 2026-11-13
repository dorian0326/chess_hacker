"use strict";

var path = require("path");
var Jieqi = require(path.join(__dirname, "..", "js", "engine.js"));

var passed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
  passed += 1;
}

function signature(state) {
  var cells = [];
  for (var r = 0; r < 10; r++) {
    for (var f = 0; f < 9; f++) {
      var p = Jieqi.pieceAt(state, f, r);
      cells.push(p ? [p.color, p.type, p.face, p.role, p.home].join(":") : ".");
    }
  }
  return cells.join("|");
}

function counts(state) {
  var out = { red: {}, black: {}, down: 0, up: 0 };
  Object.keys(state.pieces).forEach(function (id) {
    var p = state.pieces[id];
    out[p.color][p.type] = (out[p.color][p.type] || 0) + 1;
    if (p.face === "down") out.down += 1;
    else out.up += 1;
  });
  return out;
}

function consistent(state) {
  var seen = {};
  for (var r = 0; r < 10; r++) {
    for (var f = 0; f < 9; f++) {
      var id = state.board[r][f];
      if (!id) continue;
      if (seen[id]) throw new Error("重复占格 " + id);
      seen[id] = 1;
      var p = state.pieces[id];
      if (!p.alive) throw new Error("死子还在盘上");
      if (p.f !== f || p.r !== r) throw new Error("坐标不一致");
    }
  }
  Object.keys(state.pieces).forEach(function (id) {
    var p = state.pieces[id];
    if (p.alive && !seen[id]) throw new Error("活子不在盘上 " + id);
    if (!p.alive && seen[id]) throw new Error("死子幽灵 " + id);
  });
}

function has(moves, f, r, tf, tr) {
  return moves.some(function (m) {
    return m.f === f && m.r === r && m.tf === tf && m.tr === tr;
  });
}

function eventTypes(result) {
  return (result.events || []).map(function (e) {
    return e.type;
  });
}

(function setup() {
  var a = Jieqi.createGame({ rng: Jieqi.makeRng(1) });
  var b = Jieqi.createGame({ rng: Jieqi.makeRng(1) });
  var c = Jieqi.createGame({ rng: Jieqi.makeRng(2) });
  assert(signature(a) === signature(b), "同一随机种子应摆出同一盘");
  assert(signature(a) !== signature(c), "不同种子应洗出不同的盘");
  var n = counts(a);
  assert(n.down === 30 && n.up === 2, "应有 30 暗子和 2 明将，实际 " + n.down + "/" + n.up);
  ["advisor", "elephant", "rook", "horse", "cannon"].forEach(function (type) {
    assert(n.red[type] === 2 && n.black[type] === 2, type + " 应各两枚");
  });
  assert(n.red.soldier === 5 && n.black.soldier === 5, "兵卒应各五枚");
  assert(n.red.general === 1 && n.black.general === 1, "将帅各一");
  var redKing = Jieqi.pieceAt(a, 4, 0);
  var blackKing = Jieqi.pieceAt(a, 4, 9);
  assert(redKing && redKing.type === "general" && redKing.face === "up" && redKing.color === "red", "红帅明置");
  assert(blackKing && blackKing.type === "general" && blackKing.face === "up" && blackKing.color === "black", "黑将明置");
  assert(a.turn === "red" && a.status === "playing", "红方先行且开局可走");
  assert(Jieqi.allLegal(a, "red").length > 0, "红方开局有棋可走");
})();

(function horseLeg() {
  var g = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 6, r: 9 },
      { color: "red", type: "horse", face: "up", f: 4, r: 4 },
      { color: "red", type: "advisor", face: "up", f: 4, r: 5 },
    ],
  });
  var moves = Jieqi.allLegal(g, "red");
  assert(!has(moves, 4, 4, 3, 6) && !has(moves, 4, 4, 5, 6), "马腿被绊不能向前跳");
  assert(has(moves, 4, 4, 2, 3) || has(moves, 4, 4, 6, 3) || has(moves, 4, 4, 2, 5), "马仍有不被绊住的腿");
  assert(has(moves, 4, 4, 6, 5), "侧向马腿是空的，可以跳");
})();

(function cannon() {
  var g = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 8, r: 9 },
      { color: "red", type: "cannon", face: "up", f: 0, r: 0 },
      { color: "black", type: "advisor", face: "up", f: 0, r: 3 },
      { color: "black", type: "soldier", face: "up", f: 0, r: 6 },
      { color: "black", type: "horse", face: "up", f: 0, r: 8 },
    ],
  });
  var moves = Jieqi.allLegal(g, "red");
  assert(has(moves, 0, 0, 0, 1) && has(moves, 0, 0, 0, 2), "炮可以平走到隔子之前");
  assert(!has(moves, 0, 0, 0, 3), "炮不能直接吃炮架");
  assert(has(moves, 0, 0, 0, 6), "隔一子可以打到对方卒");
  assert(!has(moves, 0, 0, 0, 8), "隔两个子不能打到更远处");
})();

(function elephantAdvisorSoldier() {
  var dark = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "black", type: "soldier", face: "up", f: 4, r: 6 },
      { color: "red", type: "elephant", role: "elephant", home: "red", face: "down", f: 2, r: 4 },
      { color: "red", type: "advisor", role: "advisor", home: "red", face: "down", f: 5, r: 2 },
      { color: "red", type: "soldier", role: "soldier", home: "red", face: "down", f: 4, r: 4 },
    ],
  });
  var darkMoves = Jieqi.allLegal(dark, "red");
  assert(!has(darkMoves, 2, 4, 4, 6), "暗相不能过河");
  assert(has(darkMoves, 2, 4, 0, 2) || has(darkMoves, 2, 4, 4, 2), "暗相在己方河界内可走");
  assert(!has(darkMoves, 5, 2, 6, 3), "暗仕不能出宫");
  assert(has(darkMoves, 5, 2, 4, 1), "暗仕可在宫内斜走");
  assert(has(darkMoves, 4, 4, 4, 5), "未过河的兵只能向前");
  assert(!has(darkMoves, 4, 4, 3, 4), "未过河的兵不能横走");

  var open = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 8, r: 9 },
      { color: "red", type: "elephant", face: "up", f: 2, r: 4 },
      { color: "red", type: "advisor", face: "up", f: 5, r: 2 },
      { color: "red", type: "soldier", face: "up", f: 4, r: 5 },
      { color: "black", type: "soldier", face: "up", f: 0, r: 4 },
    ],
  });
  var openMoves = Jieqi.allLegal(open, "red");
  assert(has(openMoves, 2, 4, 4, 6), "明相可以过河");
  assert(has(openMoves, 5, 2, 6, 3), "明仕可以出宫");
  assert(has(openMoves, 4, 5, 3, 5) && has(openMoves, 4, 5, 4, 6), "过河兵可以横走和向前");
  assert(!has(openMoves, 4, 5, 4, 4), "兵不能后退");
  assert(!has(openMoves, 0, 4, 0, 5), "黑卒在红方回合不能动");
})();

(function friendAndRisk() {
  var g = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 8, r: 9 },
      { color: "red", type: "rook", face: "up", f: 0, r: 0 },
      { color: "red", type: "soldier", face: "up", f: 1, r: 0 },
      { color: "red", type: "horse", face: "down", home: "black", role: "soldier", f: 0, r: 3 },
    ],
  });
  var moves = Jieqi.allLegal(g, "red");
  assert(!has(moves, 0, 0, 1, 0), "不能吃已经翻开的己方棋");
  assert(has(moves, 0, 0, 0, 3), "可以吃暗子");
  var risk = moves.filter(function (m) {
    return m.f === 0 && m.r === 0 && m.tf === 0 && m.tr === 3;
  })[0];
  assert(risk && risk.risk, "吃暗子应标成有风险");
})();

(function flipAndCapture() {
  var own = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 8, r: 9 },
      { color: "red", type: "rook", role: "rook", home: "red", face: "down", f: 0, r: 3 },
      { color: "black", type: "soldier", face: "up", f: 0, r: 6 },
    ],
  });
  var eaten = Jieqi.move(own, 0, 3, 0, 6);
  assert(eaten.ok && eventTypes(eaten).indexOf("capture") >= 0, "揭开后吃子");
  assert(eventTypes(eaten).indexOf("explode") < 0 && eventTypes(eaten).indexOf("hunjun") < 0, "吃子不再自爆或昏君");
  var rook = Jieqi.pieceAt(own, 0, 6);
  assert(rook.face === "up" && rook.color === "red" && !rook.stains && !rook.hunjun, "吃子后仍是原来的棋");
  assert(own.captured.length === 1, "被吃的棋离场");

  var revealed = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 8, r: 9 },
      { color: "black", type: "rook", role: "rook", home: "red", face: "down", f: 0, r: 3 },
    ],
  });
  var flip = Jieqi.move(revealed, 0, 3, 0, 5);
  assert(flip.ok && eventTypes(flip).indexOf("reveal") >= 0, "走到空格是揭棋");
  var spy = Jieqi.pieceAt(revealed, 0, 5);
  assert(spy.color === "black" && spy.face === "up", "揭开后按真实颜色");
  assert(Jieqi.owns(spy, "black") && !Jieqi.owns(spy, "red"), "揭开的敌子归对方");
})();

(function checkRules() {
  var hidden = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 5, r: 9 },
      { color: "black", type: "rook", face: "up", f: 4, r: 8 },
      { color: "red", type: "rook", role: "rook", home: "red", face: "down", colorNote: "", f: 4, r: 4 },
    ],
  });
  var hid = Jieqi.move(hidden, 4, 4, 5, 4);
  assert(hid.ok && hidden.turn === "black", "未翻面的棋可以送将");
  assert(Jieqi.pieceAt(hidden, 5, 4).face === "up", "暗子落地后翻面");

  var fly = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "red", type: "advisor", face: "down", home: "red", role: "advisor", f: 4, r: 1 },
    ],
  });
  var flyHints = Jieqi.moveHints(fly, "red");
  assert(!flyHints.banned.some(function (mv) { return mv.f === 4 && mv.r === 1; }), "暗子走开不标成飞将");
  assert(flyHints.legal.some(function (mv) { return mv.f === 4 && mv.r === 1 && mv.tf === 3; }), "未翻面的棋可以走开");
  var flown = Jieqi.move(fly, 4, 1, 3, 0);
  assert(flown.ok && fly.turn === "black", "暗子走开后这一步成立");

  var knownFly = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "red", type: "advisor", face: "up", f: 4, r: 1 },
    ],
  });
  var knownFlyHints = Jieqi.moveHints(knownFly, "red");
  assert(knownFlyHints.banned.some(function (mv) { return mv.reason === "fly" && mv.f === 4 && mv.r === 1; }), "明子飞将的格子要标出来");
  assert(!knownFlyHints.legal.some(function (mv) { return mv.f === 4 && mv.r === 1 && mv.tf === 3; }), "明子飞将不在可走列表里");
  var knownFlyBefore = signature(knownFly);
  var knownFlown = Jieqi.move(knownFly, 4, 1, 3, 0);
  assert(!knownFlown.ok && knownFlown.error === "不能飞将", "明子飞将时直接阻止");
  assert(signature(knownFly) === knownFlyBefore && knownFly.turn === "red", "明子飞将不会走成");

  var known = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 5, r: 9 },
      { color: "black", type: "rook", face: "up", f: 4, r: 8 },
      { color: "red", type: "rook", face: "up", f: 4, r: 4 },
    ],
  });
  var before = signature(known);
  var bad = Jieqi.move(known, 4, 4, 5, 4);
  assert(!bad.ok && bad.error === "不能送将", "明子送将应被拒绝");
  assert(signature(known) === before, "非法步不能改变棋盘");

  var face = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "black", type: "soldier", face: "up", f: 7, r: 5 },
    ],
  });
  var escapes = Jieqi.allLegal(face, "red").filter(function (m) {
    return m.f === 4 && m.r === 0;
  });
  assert(!has(escapes, 4, 0, 4, 1), "帅不能主动照面");
  assert(has(escapes, 4, 0, 3, 0) && has(escapes, 4, 0, 5, 0), "帅可以离开相对的线");

  var pinned = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 5, r: 9 },
      { color: "black", type: "rook", face: "up", f: 4, r: 7 },
      { color: "red", type: "advisor", face: "down", home: "red", role: "advisor", f: 3, r: 0 },
      { color: "red", type: "horse", face: "down", home: "red", role: "horse", f: 7, r: 4 },
    ],
  });
  assert(pinned.status === "playing" && Jieqi.inCheck(pinned, "red"), "被将军时只要还有应将就不结束");
  var answers = Jieqi.allLegal(pinned, "red");
  assert(!answers.some(function (mv) { return mv.f === 7 && mv.r === 4; }), "解不开将军的棋不能走");
  assert(has(answers, 3, 0, 4, 1), "可以走到能挡将的格子");
  var wanderGame = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 5, r: 9 },
      { color: "black", type: "rook", face: "up", f: 4, r: 7 },
      { color: "red", type: "advisor", face: "down", home: "red", role: "advisor", f: 3, r: 0 },
      { color: "red", type: "horse", face: "down", home: "red", role: "horse", f: 7, r: 4 },
    ],
  });
  var wanderBefore = signature(wanderGame);
  var wander = Jieqi.move(wanderGame, 7, 4, 5, 3);
  assert(!wander.ok && wander.error === "被将军，必须先应将", "解不开的下一步要拦住");
  assert(signature(wanderGame) === wanderBefore, "解不开的步不能走成");
  var out = Jieqi.move(pinned, 3, 0, 4, 1);
  assert(out.ok && !Jieqi.inCheck(pinned, "red"), "挡上将后不再被将军");

  var into = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 8, r: 9 },
      { color: "black", type: "rook", face: "up", f: 5, r: 8 },
    ],
  });
  var intoHints = Jieqi.moveHints(into, "red");
  assert(intoHints.banned.some(function (mv) { return mv.f === 4 && mv.r === 0 && mv.tf === 5 && mv.tr === 0 && mv.reason === "check"; }), "帅走到会被将军的格子要标出来");
  assert(!intoHints.legal.some(function (mv) { return mv.f === 4 && mv.r === 0 && mv.tf === 5; }), "帅不能走进将军");
  var intoBefore = signature(into);
  var stepped = Jieqi.move(into, 4, 0, 5, 0);
  assert(!stepped.ok && stepped.error === "不能送将", "帅走进将军时直接阻止");
  assert(signature(into) === intoBefore && into.turn === "red", "走进将军不会走成");

  var darkMate = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "black", type: "rook", face: "up", f: 4, r: 2 },
      { color: "black", type: "rook", face: "up", f: 3, r: 1 },
      { color: "black", type: "rook", face: "up", f: 5, r: 1 },
      { color: "red", type: "horse", face: "down", home: "red", role: "horse", f: 7, r: 4 },
    ],
  });
  assert(darkMate.status === "checkmate" && darkMate.winner === "black", "没有解法时直接结束，对方赢");
  assert(darkMate.resultText.indexOf("被将杀") >= 0, "结束语写明被将杀");
})();

(function mateAndStalemate() {
  var mate = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "black", type: "rook", face: "up", f: 4, r: 2 },
      { color: "black", type: "rook", face: "up", f: 3, r: 1 },
      { color: "black", type: "rook", face: "up", f: 5, r: 1 },
    ],
  });
  assert(mate.status === "checkmate" && mate.winner === "black", "应将死判给对方");

  var stale = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "black", type: "soldier", face: "up", f: 4, r: 5 },
      { color: "black", type: "rook", face: "up", f: 3, r: 9 },
      { color: "black", type: "rook", face: "up", f: 5, r: 9 },
      { color: "black", type: "horse", face: "up", f: 2, r: 2 },
    ],
  });
  assert(!Jieqi.inCheck(stale, "red"), "困毙局面本身不是将军");
  assert(stale.status === "stalemate" && stale.winner === "black", "无子可走且未被将军为困毙");
})();

(function captureKingUndoResign() {
  var g = Jieqi.createGame({
    turn: "red",
    pieces: [
      { color: "red", type: "general", face: "up", f: 4, r: 0 },
      { color: "black", type: "general", face: "up", f: 4, r: 9 },
      { color: "red", type: "rook", face: "up", f: 3, r: 9 },
      { color: "black", type: "soldier", face: "up", f: 8, r: 4 },
    ],
  });
  var win = Jieqi.move(g, 3, 9, 4, 9);
  assert(win.ok && g.status === "capture" && g.winner === "red", "吃掉将帅即胜");
  assert(eventTypes(win).indexOf("win") >= 0, "胜利特效");
  assert(Jieqi.undo(g), "可以悔棋");
  assert(g.status === "playing" && Jieqi.pieceAt(g, 4, 9).type === "general", "悔棋后将帅回来");
  var resigned = Jieqi.resign(g);
  assert(resigned.ok && g.status === "resign" && g.winner === "black", "行棋方认输");
  assert(Jieqi.undo(g) && g.status === "playing", "认输也可以悔");
})();

(function fuzz() {
  for (var seed = 1; seed <= 12; seed++) {
    var g = Jieqi.createGame({ rng: Jieqi.makeRng(seed) });
    var rng = Jieqi.makeRng(seed * 97);
    var guard = 0;
    while (g.status === "playing" && guard < 50) {
      var moves = Jieqi.allLegal(g, g.turn);
      if (!moves.length) break;
      var mv = moves[Math.floor(rng() * moves.length)];
      var result = Jieqi.move(g, mv.f, mv.r, mv.tf, mv.tr);
      if (!result.ok) {
        throw new Error("种子 " + seed + " 第 " + guard + " 手合法步被拒绝：" + result.error + "\n" + Jieqi.debugBoard(g));
      }
      consistent(g);
      guard += 1;
    }
    var steps = g.undo.length;
    while (Jieqi.undo(g)) {}
    assert(g.moveCount === 0 && g.status === "playing", "种子 " + seed + " 全部悔棋后应回到开局");
    assert(steps === guard, "悔棋栈应与手数一致");
  }
})();

console.log("engine tests passed: " + passed);
