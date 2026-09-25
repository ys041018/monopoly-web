// ============================================================
// 音效（Web Audio API 合成，无需音频文件）
// ============================================================
let ctx = null;
let enabled = true;

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, type, vol, delay = 0) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// 白噪声（爆炸/翻牌的气声）
function noise(dur, vol, delay = 0, hp = 400) {
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = hp;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter); filter.connect(g); g.connect(c.destination);
  src.start(t0);
}

export function setSoundEnabled(v) { enabled = v; }
export function isSoundEnabled() { return enabled; }

export function play(type) {
  if (!enabled) return;
  const c = ensure();
  if (!c) return;
  switch (type) {
    case 'dice':
      tone(700, 0.05, 'square', 0.12);
      tone(500, 0.05, 'square', 0.12, 0.08);
      tone(650, 0.06, 'square', 0.1, 0.16);
      break;
    case 'buy':
      tone(1000, 0.1, 'sine', 0.18);
      tone(1400, 0.15, 'sine', 0.15, 0.06);
      break;
    case 'rent':
      tone(300, 0.2, 'triangle', 0.18);
      tone(220, 0.2, 'triangle', 0.12, 0.08);
      break;
    case 'build':
      tone(420, 0.08, 'square', 0.16);
      tone(560, 0.08, 'square', 0.14, 0.09);
      break;
    case 'card':
      tone(900, 0.06, 'sine', 0.12);
      tone(1200, 0.08, 'sine', 0.12, 0.05);
      break;
    case 'chance':
      tone(660, 0.08, 'sine', 0.14);
      tone(880, 0.08, 'sine', 0.14, 0.08);
      tone(1100, 0.12, 'sine', 0.14, 0.16);
      break;
    case 'chest':
      tone(440, 0.1, 'triangle', 0.14);
      tone(330, 0.1, 'triangle', 0.14, 0.09);
      tone(392, 0.16, 'triangle', 0.14, 0.18);
      break;
    case 'jail':
      tone(150, 0.3, 'sawtooth', 0.15);
      break;
    case 'bid':
      tone(800, 0.08, 'square', 0.14);
      break;
    case 'win':
      tone(523, 0.15, 'sine', 0.15);
      tone(659, 0.15, 'sine', 0.15, 0.15);
      tone(784, 0.35, 'sine', 0.18, 0.3);
      break;
    case 'error':
      tone(180, 0.18, 'square', 0.14);
      break;
    // ---- 演出音效 ----
    case 'tick':                       // 倒计时滴答
      tone(1200, 0.04, 'square', 0.09);
      break;
    case 'tick-urgent':                // 最后 3 秒更急促
      tone(1500, 0.05, 'square', 0.13);
      tone(1100, 0.05, 'square', 0.1, 0.06);
      break;
    case 'flip':                       // 抽卡翻牌
      noise(0.18, 0.07, 0, 1200);
      tone(880, 0.06, 'sine', 0.1, 0.02);
      break;
    case 'coin':                       // 金币飞入
      tone(1400, 0.05, 'sine', 0.11);
      tone(1900, 0.07, 'sine', 0.09, 0.05);
      break;
    case 'hammer':                     // 拍卖落槌
      tone(160, 0.16, 'sine', 0.22);
      noise(0.1, 0.12, 0, 900);
      break;
    case 'monopoly':                   // 集齐色组
      tone(600, 0.09, 'sine', 0.13);
      tone(760, 0.09, 'sine', 0.13, 0.09);
      tone(950, 0.14, 'sine', 0.15, 0.18);
      break;
    case 'bankrupt':                   // 破产爆炸
      noise(0.5, 0.22, 0, 120);
      tone(220, 0.4, 'sawtooth', 0.18, 0.02);
      tone(140, 0.5, 'sawtooth', 0.16, 0.16);
      break;
    case 'victory':                    // 胜利小旋律
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'sine', 0.16, i * 0.16));
      tone(1318, 0.5, 'sine', 0.18, 0.68);
      break;
  }
}

// 根据日志内容自动播放音效
export function playForLog(log) {
  if (!log) return;
  if (log.includes('掷出')) play('dice');
  else if (log.includes('购买了') || log.includes('拍得')) play('buy');
  else if (log.includes('租金')) play('rent');
  else if (log.includes('盖房')) play('build');
  else if (log.includes('监狱')) play('jail');
  else if (log.includes('破产') || log.includes('掉线退出')) play('bankrupt');
  else if (log.includes('获胜') || log.includes('游戏结束')) play('victory');
  else if (log.includes('公共基金')) play('coin');
  else if (log.includes('垄断') || log.includes('集齐')) play('monopoly');
  else if (log.includes('出价')) play('bid');
}
