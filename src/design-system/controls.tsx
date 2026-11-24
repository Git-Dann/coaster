import { useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { ui } from '../app/services';
import './controls.css';

export function IconButton(props: {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string;
  variant?: 'plain' | 'solid' | 'accent';
  size?: 'md' | 'lg';
}) {
  const title = props.shortcut ? `${props.label} (${props.shortcut})` : props.label;
  return (
    <button
      type="button"
      className={`cc-icon-btn ${props.variant ?? 'plain'} ${props.size ?? 'md'}${props.active ? ' active' : ''}`}
      aria-label={props.label}
      aria-pressed={props.active === undefined ? undefined : props.active}
      title={title}
      disabled={props.disabled}
      onClick={() => {
        ui('tap');
        props.onClick();
      }}
    >
      <Icon name={props.icon} />
    </button>
  );
}

export function Button(props: { children: ReactNode; onClick: () => void; variant?: 'accent' | 'plain' | 'soft'; icon?: string; disabled?: boolean; wide?: boolean; sound?: 'tap' | 'select' | 'success' }) {
  return (
    <button
      type="button"
      className={`cc-btn ${props.variant ?? 'soft'}${props.wide ? ' wide' : ''}`}
      disabled={props.disabled}
      onClick={() => {
        ui(props.sound ?? 'tap');
        props.onClick();
      }}
    >
      {props.icon && <Icon name={props.icon} size={20} />}
      <span>{props.children}</span>
    </button>
  );
}

/** Accessible range slider with a large touch track. Plays a soft tick at most every 50 ms (rate-limited in audio). */
export function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; format?: (v: number) => string }) {
  const id = useId();
  const last = useRef(props.value);
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  const shown = props.format ? props.format(props.value) : `${Number.isInteger(props.step) ? props.value.toFixed(0) : props.value.toFixed(1)}${props.unit ?? ''}`;
  return (
    <div className="cc-slider">
      <div className="cc-slider-head">
        <label htmlFor={id}>{props.label}</label>
        <output htmlFor={id}>{shown}</output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (v !== last.current) ui('slider');
          last.current = v;
          props.onChange(v);
        }}
      />
    </div>
  );
}

export function Segmented<T extends string>(props: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="cc-seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? 'on' : ''}
          onClick={() => {
            ui('select');
            props.onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean; render?: (v: number) => ReactNode }) {
  return (
    <div className="cc-stepper" role="group" aria-label={props.label}>
      <span className="cc-stepper-label">{props.label}</span>
      <div className="cc-stepper-row">
        <button
          type="button"
          aria-label={`Fewer ${props.label.toLowerCase()}`}
          disabled={props.disabled || props.value <= props.min}
          onClick={() => {
            ui('carriage-remove');
            props.onChange(props.value - 1);
          }}
        >
          <Icon name="minus" />
        </button>
        <div className="cc-stepper-value" aria-live="polite">
          {props.render ? props.render(props.value) : props.value}
        </div>
        <button
          type="button"
          aria-label={`More ${props.label.toLowerCase()}`}
          disabled={props.disabled || props.value >= props.max}
          onClick={() => {
            ui('carriage-add');
            props.onChange(props.value + 1);
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
    </div>
  );
}

export const SWATCHES = ['#C77D62', '#A9634B', '#E5C579', '#F5EBDD', '#A8B58B', '#55745B', '#8DAABB', '#4E6E8A', '#765B48', '#343C37', '#D99A8B', '#B9A6C9', '#EDE7DC', '#B9BDBA'];

export function Swatches(props: { label: string; value: string; onChange: (v: string) => void; colours?: string[] }) {
  const cols = props.colours ?? SWATCHES;
  return (
    <fieldset className="cc-swatches">
      <legend>{props.label}</legend>
      <div className="cc-swatch-row">
        {cols.map((c) => (
          <button
            key={c}
            type="button"
            className={`cc-swatch${c.toLowerCase() === props.value.toLowerCase() ? ' on' : ''}`}
            style={{ background: c }}
            aria-label={`${props.label} ${c}`}
            aria-pressed={c.toLowerCase() === props.value.toLowerCase()}
            onClick={() => {
              ui('colour');
              props.onChange(c);
            }}
          />
        ))}
        <label className="cc-swatch custom" title="Custom colour">
          <input type="color" value={props.value} aria-label={`${props.label} custom colour`} onChange={(e) => props.onChange(e.target.value)} />
          <Icon name="plus" size={16} />
        </label>
      </div>
    </fieldset>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="cc-toggle">
      <label htmlFor={id}>
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={props.checked}
        className={props.checked ? 'on' : ''}
        onClick={() => {
          ui('toggle');
          props.onChange(!props.checked);
        }}
      >
        <span />
      </button>
    </div>
  );
}

export function Tiles<T extends string>(props: { label: string; value: T | null; options: Array<{ value: T; label: string; icon?: string; swatch?: string }>; onChange: (v: T) => void; columns?: number }) {
  return (
    <div className="cc-tiles" role="radiogroup" aria-label={props.label} style={{ ['--cols' as string]: props.columns ?? 3 }}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? 'on' : ''}
          onClick={() => {
            ui('select');
            props.onChange(o.value);
          }}
        >
          {o.swatch ? <span className="cc-tile-swatch" style={{ background: o.swatch }} /> : o.icon ? <Icon name={o.icon} /> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
