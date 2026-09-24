import { describe, expect, it } from 'vitest';
import { TouchAdapter } from './touch.js';

class ElementStub extends EventTarget {
  dataset: Record<string, string> = {};
  private captured = new Set<number>();
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
  html(): HTMLElement {
    return this as unknown as HTMLElement;
  }
  press(): void {
    this.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1 }));
  }
}

describe('touch pause delivery', () => {
  it('calls the immediate handler without queueing a second pause', () => {
    const stick = new ElementStub();
    const look = new ElementStub();
    const button = new ElementStub();
    let calls = 0;
    const adapter = new TouchAdapter(stick.html(), look.html(), {
      onPausePressed: () => {
        calls += 1;
      },
    });
    adapter.bindButton(button.html(), 'pause');
    adapter.setEnabled(true);
    button.press();
    expect(calls).toBe(1);
    expect(adapter.drain().pausePressed).toBe(false);
    adapter.dispose();
  });

  it('queues one pause without a callback, and reset clears it', () => {
    const adapter = new TouchAdapter(new ElementStub().html(), new ElementStub().html());
    const button = new ElementStub();
    adapter.bindButton(button.html(), 'pause');
    adapter.setEnabled(true);
    button.press();
    expect(adapter.drain().pausePressed).toBe(true);
    expect(adapter.drain().pausePressed).toBe(false);
    button.press();
    adapter.reset();
    expect(adapter.drain().pausePressed).toBe(false);
    adapter.dispose();
  });
});
