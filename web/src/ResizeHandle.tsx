import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type Props = {
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (width: number) => void;
  label: string;
};

/** Draggable divider between a side panel and the canvas. */
export function ResizeHandle({ side, width, min, max, defaultValue, onChange, label }: Props) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const active = useRef(false);

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    active.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={(event) => {
        event.preventDefault();
        drag.current = { x: event.clientX, width };
        active.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const delta = event.clientX - drag.current.x;
        const next = side === 'left' ? drag.current.width + delta : drag.current.width - delta;
        onChange(Math.max(min, Math.min(max, next)));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => onChange(defaultValue)}
      className="group relative z-20 -mx-0.5 w-1.5 shrink-0 cursor-col-resize touch-none bg-transparent max-lg:hidden"
    >
      <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${active.current ? 'bg-strong' : 'bg-border group-hover:bg-strong'}`} />
    </div>
  );
}
