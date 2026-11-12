/* 翻棋音效由 Web Audio 实时合成。背景乐使用 audio/bgm.mp3。 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FanqiAudio = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var ctx = null;
  var master = null;
  var sfxGain = null;
  var enabled = true;
  var noiseBuf = null;
  var music = null;
  var duckTimer = 0;
  var MUSIC_VOL = 0.42;

  var SCALE = [293.66, 329.63, 392.0, 440.0, 523.25];

  function ensure() {
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.8;
      sfxGain.connect(master);
    }
    if (ctx.state === "suspended") ctx.resume();
    return true;
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    var len = ctx.sampleRate * 1.2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function burst(when, dur, freq, q, gain, type) {
    var src = ctx.createBufferSource();
    src.buffer = noise();
    var filter = ctx.createBiquadFilter();
    filter.type = type || "bandpass";
    filter.frequency.setValueAtTime(freq, when);
    filter.Q.value = q;
    var amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(gain, when + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(sfxGain);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  function tone(when, freq, dur, type, gain, dest) {
    var osc = ctx.createOscillator();
    var amp = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, when);
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(gain, when + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(amp);
    amp.connect(dest || sfxGain);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    return osc;
  }

  function pluck(when, freq, dur, gain, dest) {
    var rate = ctx.sampleRate;
    var length = Math.max(2, Math.round(rate / freq));
    var buffer = ctx.createBuffer(1, length, rate);
    var data = buffer.getChannelData(0);
    var i;
    for (i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    for (i = 1; i < length; i++) data[i] = (data[i - 1] + data[i]) * 0.5;
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    var filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(2400, freq * 6), when);
    filter.frequency.exponentialRampToValueAtTime(Math.max(180, freq), when + dur);
    var amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(gain, when + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(dest || sfxGain);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  function body(when, freq, dur, gain) {
    tone(when, freq, dur, "sine", gain);
    tone(when, freq * 0.5, dur * 0.8, "triangle", gain * 0.35);
  }

  function ensureMusic() {
    if (music || typeof root.Audio !== "function") return;
    music = new root.Audio("audio/bgm.mp3");
    music.loop = true;
    music.volume = MUSIC_VOL;
    music.preload = "auto";
  }

  function tryPlay() {
    if (!enabled) return;
    ensureMusic();
    if (!music || !music.paused) return;
    var pending = music.play();
    if (pending && pending.catch) pending.catch(function () {});
  }

  function startMusic() {
    tryPlay();
  }

  function duck() {
    if (!enabled || !music) return;
    music.volume = 0.12;
    clearTimeout(duckTimer);
    duckTimer = setTimeout(function () {
      if (enabled && music) music.volume = MUSIC_VOL;
    }, 1100);
  }

  function play(kind) {
    if (!enabled || !ensure()) return;
    var t = ctx.currentTime;
    if (kind === "select") {
      pluck(t, 660, 0.18, 0.03);
    } else if (kind === "move") {
      burst(t, 0.09, 420, 0.7, 0.16, "lowpass");
      body(t, 168, 0.12, 0.05);
    } else if (kind === "flip" || kind === "reveal") {
      burst(t, 0.16, 1400, 0.6, 0.08, "highpass");
      pluck(t, 523, 0.28, 0.05);
      pluck(t + 0.06, 784, 0.32, 0.04);
    } else if (kind === "capture") {
      burst(t, 0.12, 280, 0.8, 0.2, "lowpass");
      body(t, 110, 0.2, 0.07);
      pluck(t, 220, 0.25, 0.04);
    } else if (kind === "borrow") {
      duck();
      pluck(t, 587, 0.22, 0.06);
      pluck(t + 0.1, 880, 0.28, 0.055);
      pluck(t + 0.2, 1174, 0.4, 0.04);
    } else if (kind === "deceive" || kind === "fratricide") {
      duck();
      pluck(t, 440, 0.28, 0.05);
      pluck(t + 0.12, 349, 0.32, 0.05);
      pluck(t + 0.24, 262, 0.45, 0.045);
      body(t, 98, 0.3, 0.04);
    } else if (kind === "wolf" || kind === "sleeper") {
      duck();
      tone(t, 415, 0.28, "sine", 0.04);
      tone(t, 440, 0.34, "sine", 0.035);
      pluck(t + 0.05, 311, 0.4, 0.04);
    } else if (kind === "explode") {
      duck();
      burst(t, 0.45, 900, 0.4, 0.22, "lowpass");
      var drop = ctx.createOscillator();
      var amp = ctx.createGain();
      drop.type = "sawtooth";
      drop.frequency.setValueAtTime(180, t);
      drop.frequency.exponentialRampToValueAtTime(40, t + 0.45);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      drop.connect(amp);
      amp.connect(sfxGain);
      drop.start(t);
      drop.stop(t + 0.52);
    } else if (kind === "hunjun") {
      duck();
      body(t, 55, 0.7, 0.08);
      tone(t + 0.08, 196, 0.8, "sine", 0.04);
      tone(t + 0.08, 185, 0.8, "sine", 0.03);
    } else if (kind === "check") {
      tone(t, 880, 0.1, "sine", 0.04);
      tone(t + 0.12, 988, 0.14, "sine", 0.04);
    } else if (kind === "win") {
      duck();
      [0, 2, 4, 3, 4].forEach(function (n, i) {
        pluck(t + i * 0.14, SCALE[n] * 2, 0.55, 0.05);
      });
      body(t, 73.4, 0.9, 0.05);
    } else if (kind === "bad") {
      burst(t, 0.12, 180, 0.6, 0.1, "lowpass");
      tone(t, 92, 0.16, "triangle", 0.04);
    }
  }

  function setEnabled(flag) {
    enabled = !!flag;
    if (ctx && ctx.state === "suspended" && enabled) ctx.resume();
    if (!enabled) {
      if (music) music.pause();
      return;
    }
    if (music) music.volume = MUSIC_VOL;
    tryPlay();
  }

  function unlock() {
    if (!enabled) return;
    ensure();
    tryPlay();
  }

  tryPlay();

  return {
    play: play,
    unlock: unlock,
    start: tryPlay,
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
  };
});
