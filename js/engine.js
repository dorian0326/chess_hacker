/* 翻棋 demo v1.0
 * 揭棋走法：将帅明置，其余三十子洗入双方阵位。
 * 暗子按所在格的原棋种走，走完翻面；之后按真实棋种走。
 * 仕相揭开后可过河。将帅不出九宫，不可照面。
 * 只保留翻棋、吃子和将杀。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Jieqi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var GLYPH = {
    red: {
      general: "帥",
      advisor: "仕",
      elephant: "相",
      rook: "俥",
      horse: "傌",
      cannon: "炮",
      soldier: "兵",
    },
    black: {
      general: "將",
      advisor: "士",
      elephant: "象",
      rook: "車",
      horse: "馬",
      cannon: "砲",
      soldier: "卒",
    },
  };

  var ORTH = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  function opposite(color) {
    return color === "red" ? "black" : "red";
  }

  function sideName(color) {
    return color === "red" ? "红方" : "黑方";
  }

  function onBoard(f, r) {
    return f >= 0 && f < 9 && r >= 0 && r < 10;
  }

  function inPalace(side, f, r) {
    if (f < 3 || f > 5) return false;
    return side === "red" ? r >= 0 && r <= 2 : r >= 7 && r <= 9;
  }

  function emptyBoard() {
    var board = [];
    for (var r = 0; r < 10; r++) {
      var row = [];
      for (var f = 0; f < 9; f++) row.push(null);
      board.push(row);
    }
    return board;
  }

  function pieceAt(state, f, r) {
    if (!onBoard(f, r)) return null;
    var id = state.board[r][f];
    return id ? state.pieces[id] : null;
  }

  function owns(piece, side) {
    if (!piece || !piece.alive) return false;
    if (piece.face === "down") return piece.home === side;
    return piece.color === side;
  }

  function findGeneral(state, color) {
    var pieces = state.pieces;
    for (var id in pieces) {
      if (!Object.prototype.hasOwnProperty.call(pieces, id)) continue;
      var p = pieces[id];
      if (p.alive && p.type === "general" && p.color === color) return p;
    }
    return null;
  }

  function label(piece) {
    var who = piece.color === "red" ? "红" : "黑";
    return who + GLYPH[piece.color][piece.type];
  }

  function roleGlyph(home, role) {
    return GLYPH[home][role];
  }

  function pieceCard(piece, tag, relation) {
    var card = { color: piece.color, glyph: GLYPH[piece.color][piece.type], tag: tag || "" };
    if (relation) card.relation = relation;
    return card;
  }

  function flipCards(mover, victim, wasDown) {
    var cards = [];
    if (wasDown) cards.push(pieceCard(mover, "翻出", victim ? "eater" : ""));
    else if (victim) cards.push(pieceCard(mover, "", "eater"));
    if (victim) cards.push(pieceCard(victim, "", "eaten"));
    return cards;
  }

  function publicName(piece) {
    if (!piece) return "";
    if (piece.face === "down") return "暗子";
    return label(piece);
  }

  var RED_FILE = ["九", "八", "七", "六", "五", "四", "三", "二", "一"];

  function coord(f, r) {
    return RED_FILE[f] + (r + 1);
  }

  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rng) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function clone(state) {
    var had = Object.prototype.hasOwnProperty.call(state, "undo");
    var undo = state.undo;
    if (had) delete state.undo;
    try {
      return JSON.parse(JSON.stringify(state));
    } finally {
      if (had) state.undo = undo;
    }
  }

  function replace(target, source) {
    var key;
    for (key in target) {
      if (Object.prototype.hasOwnProperty.call(target, key)) delete target[key];
    }
    var copy = JSON.parse(JSON.stringify(source));
    for (key in copy) {
      if (Object.prototype.hasOwnProperty.call(copy, key)) target[key] = copy[key];
    }
  }

  function blankState(turn) {
    return {
      pieces: {},
      board: emptyBoard(),
      turn: turn || "red",
      captured: [],
      log: [],
      moveCount: 0,
      status: "playing",
      winner: null,
      resultText: "",
      lastMove: null,
      nextId: 1,
      undo: [],
    };
  }

  function addPiece(state, spec) {
    if (!onBoard(spec.f, spec.r)) throw new Error("坐标超出棋盘");
    if (state.board[spec.r][spec.f]) throw new Error("格子上已有棋子");
    var id = "p" + state.nextId++;
    var piece = {
      id: id,
      color: spec.color,
      type: spec.type,
      role: spec.role || spec.type,
      home: spec.home || spec.color,
      face: spec.face || "up",
      f: spec.f,
      r: spec.r,
      alive: true,
    };
    state.pieces[id] = piece;
    state.board[spec.r][spec.f] = id;
    return piece;
  }

  function campSlots(home) {
    var backRank = home === "red" ? 0 : 9;
    var cannonRank = home === "red" ? 2 : 7;
    var soldierRank = home === "red" ? 3 : 6;
    var back = ["rook", "horse", "elephant", "advisor", "general", "advisor", "elephant", "horse", "rook"];
    var slots = [];
    var f;
    for (f = 0; f < 9; f++) {
      if (back[f] === "general") continue;
      slots.push({ f: f, r: backRank, role: back[f], home: home });
    }
    slots.push({ f: 1, r: cannonRank, role: "cannon", home: home });
    slots.push({ f: 7, r: cannonRank, role: "cannon", home: home });
    var files = [0, 2, 4, 6, 8];
    for (var i = 0; i < files.length; i++) {
      slots.push({ f: files[i], r: soldierRank, role: "soldier", home: home });
    }
    return slots;
  }

  function poolFor(color) {
    var plan = [
      ["advisor", 2],
      ["elephant", 2],
      ["rook", 2],
      ["horse", 2],
      ["cannon", 2],
      ["soldier", 5],
    ];
    var list = [];
    for (var i = 0; i < plan.length; i++) {
      for (var n = 0; n < plan[i][1]; n++) {
        list.push({ color: color, type: plan[i][0] });
      }
    }
    return list;
  }

  function placeShuffled(state, rng) {
    var slots = campSlots("red").concat(campSlots("black"));
    var pool = poolFor("red").concat(poolFor("black"));
    shuffle(pool, rng);
    for (var i = 0; i < slots.length; i++) {
      addPiece(state, {
        color: pool[i].color,
        type: pool[i].type,
        role: slots[i].role,
        home: slots[i].home,
        face: "down",
        f: slots[i].f,
        r: slots[i].r,
      });
    }
    addPiece(state, { color: "red", type: "general", face: "up", f: 4, r: 0, home: "red" });
    addPiece(state, { color: "black", type: "general", face: "up", f: 4, r: 9, home: "black" });
  }

  function destinations(state, piece, side, attack) {
    var kind = piece.face === "down" ? piece.role : piece.type;
    var out = [];

    function pushLand(f, r) {
      if (!onBoard(f, r)) return false;
      var target = pieceAt(state, f, r);
      if (!target) {
        out.push({ f: f, r: r, capture: false });
        return true;
      }
      if (attack || target.face === "down" || target.color !== side) {
        out.push({ f: f, r: r, capture: true });
      }
      return false;
    }

    var i;
    if (kind === "rook") {
      for (i = 0; i < ORTH.length; i++) {
        var df = ORTH[i][0];
        var dr = ORTH[i][1];
        var f = piece.f + df;
        var r = piece.r + dr;
        while (onBoard(f, r)) {
          if (!pushLand(f, r)) break;
          f += df;
          r += dr;
        }
      }
    } else if (kind === "cannon") {
      for (i = 0; i < ORTH.length; i++) {
        var cdf = ORTH[i][0];
        var cdr = ORTH[i][1];
        var cf = piece.f + cdf;
        var cr = piece.r + cdr;
        var jumped = false;
        while (onBoard(cf, cr)) {
          var target = pieceAt(state, cf, cr);
          if (!jumped) {
            if (!target) out.push({ f: cf, r: cr, capture: false });
            else jumped = true;
          } else if (target) {
            if (attack || target.face === "down" || target.color !== side) {
              out.push({ f: cf, r: cr, capture: true });
            }
            break;
          }
          cf += cdf;
          cr += cdr;
        }
      }
    } else if (kind === "horse") {
      var legs = [
        [2, 1, 1, 0],
        [2, -1, 1, 0],
        [-2, 1, -1, 0],
        [-2, -1, -1, 0],
        [1, 2, 0, 1],
        [1, -2, 0, -1],
        [-1, 2, 0, 1],
        [-1, -2, 0, -1],
      ];
      for (i = 0; i < legs.length; i++) {
        var legF = piece.f + legs[i][2];
        var legR = piece.r + legs[i][3];
        if (!onBoard(legF, legR) || pieceAt(state, legF, legR)) continue;
        pushLand(piece.f + legs[i][0], piece.r + legs[i][1]);
      }
    } else if (kind === "elephant") {
      var eyes = [
        [2, 2, 1, 1],
        [2, -2, 1, -1],
        [-2, 2, -1, 1],
        [-2, -2, -1, -1],
      ];
      for (i = 0; i < eyes.length; i++) {
        var tf = piece.f + eyes[i][0];
        var tr = piece.r + eyes[i][1];
        if (!onBoard(tf, tr)) continue;
        if (piece.face === "down") {
          if (piece.home === "red" && tr > 4) continue;
          if (piece.home === "black" && tr < 5) continue;
        }
        if (pieceAt(state, piece.f + eyes[i][2], piece.r + eyes[i][3])) continue;
        pushLand(tf, tr);
      }
    } else if (kind === "advisor") {
      var diag = [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ];
      for (i = 0; i < diag.length; i++) {
        var af = piece.f + diag[i][0];
        var ar = piece.r + diag[i][1];
        if (!onBoard(af, ar)) continue;
        if (piece.face === "down" && !inPalace(piece.home, af, ar)) continue;
        pushLand(af, ar);
      }
    } else if (kind === "general") {
      for (i = 0; i < ORTH.length; i++) {
        var gf = piece.f + ORTH[i][0];
        var gr = piece.r + ORTH[i][1];
        if (!inPalace(piece.color, gf, gr)) continue;
        pushLand(gf, gr);
      }
    } else if (kind === "soldier") {
      var color = piece.face === "down" ? piece.home : piece.color;
      var forward = color === "red" ? 1 : -1;
      var crossed = color === "red" ? piece.r >= 5 : piece.r <= 4;
      var steps = [[0, forward]];
      if (crossed) steps.push([1, 0], [-1, 0]);
      for (i = 0; i < steps.length; i++) pushLand(piece.f + steps[i][0], piece.r + steps[i][1]);
    }
    return out;
  }

  function attacks(state, piece, tf, tr) {
    var dests = destinations(state, piece, piece.color, true);
    for (var i = 0; i < dests.length; i++) {
      if (dests[i].capture && dests[i].f === tf && dests[i].r === tr) return true;
    }
    return false;
  }

  function inCheck(state, color) {
    var general = findGeneral(state, color);
    if (!general) return false;
    var enemy = opposite(color);
    var id;
    for (id in state.pieces) {
      if (!Object.prototype.hasOwnProperty.call(state.pieces, id)) continue;
      var piece = state.pieces[id];
      if (!piece.alive || piece.face !== "up" || piece.color !== enemy) continue;
      if (attacks(state, piece, general.f, general.r)) return true;
    }
    var other = findGeneral(state, enemy);
    if (other && other.f === general.f) {
      var blocked = false;
      var a = Math.min(general.r, other.r) + 1;
      var b = Math.max(general.r, other.r);
      for (var r = a; r < b; r++) {
        if (state.board[r][general.f]) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return true;
    }
    return false;
  }

  function generalsFace(state) {
    var red = findGeneral(state, "red");
    var black = findGeneral(state, "black");
    if (!red || !black || red.f !== black.f) return false;
    var low = Math.min(red.r, black.r) + 1;
    var high = Math.max(red.r, black.r);
    for (var r = low; r < high; r++) {
      if (state.board[r][red.f]) return false;
    }
    return true;
  }

  function commitMeta(state, side, f, r, tf, tr, events) {
    state.moveCount += 1;
    state.lastMove = { f: f, r: r, tf: tf, tr: tr };
    var main = null;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!main && (ev.type === "capture" || ev.type === "reveal")) main = ev;
    }
    var head = state.moveCount + ". " + sideName(side) + " " + coord(f, r) + " → " + coord(tf, tr);
    if (main) state.log.push({ n: state.moveCount, text: head + " · " + main.title + "：" + main.sub });
    else state.log.push({ n: state.moveCount, text: head });
  }

  function settleTerminal(state) {
    if (state.status !== "playing") return null;
    var side = state.turn;
    if (!findGeneral(state, side)) {
      state.status = "capture";
      state.winner = opposite(side);
      state.resultText = sideName(state.winner) + "胜";
      return "capture";
    }
    var moves = allLegal(state, side);
    if (moves.length === 0) {
      var mate = inCheck(state, side);
      state.status = mate ? "checkmate" : "stalemate";
      state.winner = opposite(side);
      state.resultText = mate
        ? sideName(side) + "被将杀，" + sideName(state.winner) + "胜"
        : sideName(state.winner) + "胜 · 困毙";
      return state.status;
    }
    return null;
  }

  function apply(state, f, r, tf, tr, probe) {
    if (state.status !== "playing") return { ok: false, error: "对局已经结束" };
    var side = state.turn;
    var mover = pieceAt(state, f, r);
    if (!mover || !owns(mover, side)) return { ok: false, error: "现在不能走这枚棋子" };
    var victim = pieceAt(state, tf, tr);
    var dests = destinations(state, mover, side, false);
    var allowed = false;
    for (var i = 0; i < dests.length; i++) {
      if (dests[i].f === tf && dests[i].r === tr) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return { ok: false, error: "这一步不合规则" };

    var wasInCheck = inCheck(state, side);
    var wasDown = mover.face === "down";
    var stepRole = roleGlyph(mover.home, mover.role);

    state.board[r][f] = null;
    state.board[tr][tf] = mover.id;
    mover.f = tf;
    mover.r = tr;
    if (wasDown) mover.face = "up";

    var events = [];
    if (victim) {
      victim.alive = false;
      victim.f = -1;
      victim.r = -1;
      if (victim.face === "down") victim.face = "up";
      state.captured.push(victim.id);
      events.push({
        type: "capture",
        title: "吃子",
        sub: wasDown
          ? "按「" + stepRole + "」揭开，是" + label(mover) + "，吃掉" + label(victim) + "。"
          : label(mover) + "吃掉" + label(victim) + "。",
        cards: flipCards(mover, victim, wasDown),
      });

      if (victim.type === "general") {
        state.status = "capture";
        state.winner = side;
        state.resultText = sideName(side) + "胜 · 吃掉" + sideName(opposite(side)) + "将帅";
        events.push({ type: "win", title: sideName(side) + "胜", sub: state.resultText });
        if (!probe) commitMeta(state, side, f, r, tf, tr, events);
        return { ok: true, events: events };
      }
    } else if (wasDown) {
      events.push({
        type: "reveal",
        title: "揭棋",
        sub: mover.color === side
          ? "按「" + stepRole + "」揭开，是" + label(mover) + "。"
          : "按「" + stepRole + "」揭开，是" + label(mover) + "，归对方。",
        cards: [pieceCard(mover, "翻出")],
      });
    }

    if (!probe && state.winner !== side) {
      var flying = generalsFace(state);
      var still = inCheck(state, side);
      if (wasInCheck && (flying || still)) {
        return { ok: false, error: flying ? "不能飞将" : "被将军，必须先应将" };
      }
      if (!wasDown && flying) return { ok: false, error: "不能飞将" };
      if (!wasDown && still) return { ok: false, error: "不能送将" };
    }
    if (probe) return { ok: true, events: events };

    commitMeta(state, side, f, r, tf, tr, events);
    state.turn = opposite(side);
    var terminal = settleTerminal(state);
    var winTitle = "被将杀";
    if (terminal === "stalemate") winTitle = "困毙";
    else if (terminal === "capture") winTitle = "胜";
    if (terminal === "checkmate" || terminal === "stalemate" || terminal === "capture") {
      var winCards = [];
      if (terminal === "checkmate") {
        var fallen = findGeneral(state, state.turn);
        if (fallen) winCards = [pieceCard(fallen, "被将杀")];
      }
      events.push({ type: "win", title: winTitle, sub: state.resultText, cards: winCards });
      state.log.push({ n: state.moveCount, text: state.resultText });
    } else if (inCheck(state, state.turn)) {
      var checked = findGeneral(state, state.turn);
      events.push({
        type: "check",
        title: "将军",
        sub: sideName(state.turn) + "被将军，必须应将。",
        cards: checked ? [pieceCard(checked, "被将")] : [],
      });
      state.log.push({ n: state.moveCount, text: "将军" });
    }
    return { ok: true, events: events };
  }

  function moveHints(state, side) {
    var legal = [];
    var banned = [];
    if (!state || state.status !== "playing") return { legal: legal, banned: banned };
    var wasInCheck = inCheck(state, side);
    var id;
    for (id in state.pieces) {
      if (!Object.prototype.hasOwnProperty.call(state.pieces, id)) continue;
      var piece = state.pieces[id];
      if (!owns(piece, side)) continue;
      var dests = destinations(state, piece, side, false);
      for (var i = 0; i < dests.length; i++) {
        var dest = dests[i];
        var victim = pieceAt(state, dest.f, dest.r);
        var next = clone(state);
        var result = apply(next, piece.f, piece.r, dest.f, dest.r, true);
        if (!result.ok) continue;
        var item = {
          f: piece.f,
          r: piece.r,
          tf: dest.f,
          tr: dest.r,
          capture: !!victim,
          risk: !!(victim && victim.face === "down"),
        };
        var reason = "";
        var won = next.winner === side;
        var flying = !won && generalsFace(next);
        var checked = !won && inCheck(next, side);
        if (wasInCheck && (flying || checked)) reason = flying ? "fly" : "escape";
        else if (piece.face !== "down" && flying) reason = "fly";
        else if (piece.face !== "down" && checked) reason = "check";
        if (reason) {
          item.reason = reason;
          banned.push(item);
        } else {
          legal.push(item);
        }
      }
    }
    return { legal: legal, banned: banned };
  }

  function allLegal(state, side) {
    return moveHints(state, side).legal;
  }

  function createGame(options) {
    options = options || {};
    var state = blankState(options.turn || "red");
    state.gameId =
      options.gameId ||
      "g" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    if (options.pieces) {
      for (var i = 0; i < options.pieces.length; i++) addPiece(state, options.pieces[i]);
    } else {
      placeShuffled(state, options.rng || Math.random);
    }
    settleTerminal(state);
    return state;
  }

  function move(state, f, r, tf, tr) {
    var next = clone(state);
    var result = apply(next, f, r, tf, tr, false);
    if (!result.ok) return result;
    if (!state.undo) state.undo = [];
    state.undo.push(clone(state));
    var stack = state.undo;
    replace(state, next);
    state.undo = stack;
    return result;
  }

  function undo(state) {
    if (!state.undo || state.undo.length === 0) return false;
    var stack = state.undo;
    var prev = stack.pop();
    replace(state, prev);
    state.undo = stack;
    return true;
  }

  function resign(state) {
    if (state.status !== "playing") return { ok: false, error: "对局已经结束" };
    if (!state.undo) state.undo = [];
    state.undo.push(clone(state));
    var loser = state.turn;
    var winner = opposite(loser);
    state.status = "resign";
    state.winner = winner;
    state.resultText = sideName(loser) + "认输，" + sideName(winner) + "胜";
    state.log.push({ n: state.moveCount, text: state.resultText });
    return {
      ok: true,
      events: [{ type: "win", title: sideName(winner) + "胜", sub: state.resultText }],
    };
  }

  function debugBoard(state) {
    var lines = [];
    for (var r = 9; r >= 0; r--) {
      var line = (r < 10 ? " " : "") + r;
      for (var f = 0; f < 9; f++) {
        var piece = pieceAt(state, f, r);
        if (!piece) line += " ·";
        else if (piece.face === "down") line += " ?";
        else line += (piece.color === "red" ? "r" : "b") + GLYPH[piece.color][piece.type];
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  return {
    GLYPH: GLYPH,
    createGame: createGame,
    move: move,
    undo: undo,
    resign: resign,
    allLegal: allLegal,
    moveHints: moveHints,
    inCheck: inCheck,
    pieceAt: pieceAt,
    owns: owns,
    publicName: publicName,
    sideName: sideName,
    coord: coord,
    makeRng: makeRng,
    debugBoard: debugBoard,
    opposite: opposite,
  };
});
