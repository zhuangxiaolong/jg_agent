import type { CompletionSound } from '../../../../packages/domain/src';

const melodies: Record<Exclude<CompletionSound, 'off'>, number[]> = {
  chime: [880, 660],
  bright: [660, 880, 1175],
  soft: [523, 659],
};

export function playCompletionSound(sound: CompletionSound): void {
  if (sound === 'off') return;
  try {
    const context = new AudioContext();
    void context.resume().then(() => {
      const now = context.currentTime;
      melodies[sound].forEach((frequency, index) => {
        const start = now + index * 0.17;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = sound === 'soft' ? 'triangle' : 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(sound === 'soft' ? 0.055 : 0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(start); oscillator.stop(start + 0.15);
      });
      window.setTimeout(() => { void context.close(); }, 700);
    }).catch(() => { void context.close(); });
  } catch { /* 音频设备不可用时仍保留界面通知。 */ }
}
