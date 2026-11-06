// Six boxes for a six-digit code. Typing moves along, backspace moves back, and
// pasting a whole code fills them all. To a screen reader it is a labelled group
// of six numbered fields, and the first takes the phone's one-time-code autofill.
import { useEffect, useRef } from 'react';

const LENGTH = 6;

export function CodeBoxes({ value, onChange, onComplete, label, disabled = false, invalid = false }: {
  value: string; onChange: (value: string) => void; onComplete?: (value: string) => void; label: string; disabled?: boolean; invalid?: boolean;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => { boxes.current[Math.min(value.length, LENGTH - 1)]?.focus(); }, []);

  function update(next: string, focus: number) {
    const digits = next.replace(/\D/g, '').slice(0, LENGTH);
    onChange(digits);
    boxes.current[Math.min(focus, LENGTH - 1)]?.focus();
    if (digits.length === LENGTH) onComplete?.(digits);
  }

  return (
    <div role="group" aria-label={label} className="grid grid-cols-6 gap-1.5">
      {Array.from({ length: LENGTH }, (_, index) => (
        <input
          key={index}
          ref={element => { boxes.current[index] = element; }}
          className="code-box"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${index + 1} of ${LENGTH}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={value[index] ?? ''}
          onFocus={event => event.currentTarget.select()}
          onChange={event => {
            const typed = event.target.value.replace(/\D/g, '');
            if (!typed) return;
            // More than a digit here means a paste or an autofill: it starts at
            // this box and runs on from there.
            update(value.slice(0, index) + typed + value.slice(index + typed.length), index + typed.length);
          }}
          onPaste={event => {
            event.preventDefault();
            const pasted = event.clipboardData.getData('text').replace(/\D/g, '');
            if (pasted) update(pasted, pasted.length);
          }}
          onKeyDown={event => {
            if (event.key === 'Backspace') {
              event.preventDefault();
              if (value[index]) update(value.slice(0, index) + value.slice(index + 1), index);
              else if (index > 0) update(value.slice(0, index - 1) + value.slice(index), index - 1);
            }
            if (event.key === 'ArrowLeft' && index > 0) boxes.current[index - 1]?.focus();
            if (event.key === 'ArrowRight' && index < LENGTH - 1) boxes.current[index + 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}
