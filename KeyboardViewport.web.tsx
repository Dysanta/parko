import { useEffect, useRef, type CSSProperties } from 'react';
import { View } from 'react-native';
import type { KeyboardViewportProps } from './KeyboardViewport';

const frame: CSSProperties = {
  position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden',
};
const visibleArea: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' };

function revealFocusedField(container: HTMLElement) {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !container.contains(field) ||
    !field.matches('input, textarea, [contenteditable="true"]')) return;

  for (let parent = field.parentElement; parent && parent !== container; parent = parent.parentElement) {
    if (!/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
    const bounds = parent.getBoundingClientRect();
    const fieldBounds = field.getBoundingClientRect();
    const margin = 12;
    if (fieldBounds.bottom + margin > bounds.bottom) {
      parent.scrollTop += fieldBounds.bottom + margin - bounds.bottom;
    } else if (fieldBounds.top - margin < bounds.top) {
      parent.scrollTop -= bounds.top - fieldBounds.top + margin;
    }
    break;
  }
}

export function KeyboardViewport({ children, style, modal = false }: KeyboardViewportProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    const container = frameRef.current;
    const content = contentRef.current;
    if (!viewport || !container || !content) return;
    let scheduled = 0;

    function update() {
      if (!viewport || !container || !content) return;
      // The modal's slide animation translates the dialog without changing its layout.
      const top = modal ? 0 : container.getBoundingClientRect().top;
      const bottom = viewport.offsetTop + viewport.height;
      content.style.top = `${Math.max(0, viewport.offsetTop - top)}px`;
      content.style.bottom = `${Math.max(0, top + container.clientHeight - bottom)}px`;
      revealFocusedField(content);
    }

    function schedule() {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(update);
    }

    schedule();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    container.addEventListener('focusin', schedule);
    return () => {
      cancelAnimationFrame(scheduled);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      container.removeEventListener('focusin', schedule);
    };
  }, [modal]);

  return (
    <div ref={frameRef} style={frame}>
      <div ref={contentRef} style={visibleArea}>
        <View style={style}>{children}</View>
      </div>
    </div>
  );
}
