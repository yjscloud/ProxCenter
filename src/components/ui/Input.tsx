/* ==========================================================================
   ProxCenter — Input / Select / Textarea / Switch / Checkbox / RadioGroup
   ========================================================================== */

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/* ---------------------------------------------------------------------------
   Field 外壳（label + 错误提示）
   --------------------------------------------------------------------------- */

export interface FieldProps {
  label?: ReactNode;
  /** 错误文案，非空时显示红字 */
  error?: string;
  /** 帮助文案 */
  hint?: string;
  required?: boolean;
  htmlFor?: string;
  /** 标签行右侧的附属内容（如密码框旁的「忘记密码？」链接） */
  labelExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  error,
  hint,
  required,
  htmlFor,
  labelExtra,
  children,
  className,
}: FieldProps) {
  return (
    <div className={`field ${error ? 'field-error' : ''} ${className ?? ''}`}>
      {label ? (
        labelExtra ? (
          <div className="field-label-row">
            <label className="field-label" htmlFor={htmlFor}>
              {label}
              {required ? (
                <span className="field-required" aria-hidden="true">
                  *
                </span>
              ) : null}
            </label>
            <span className="field-label-extra">{labelExtra}</span>
          </div>
        ) : (
          <label className="field-label" htmlFor={htmlFor}>
            {label}
            {required ? (
              <span className="field-required" aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
        )
      ) : null}
      {children}
      {error ? (
        <div className="field-message field-message-error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="field-message">{hint}</div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Input
   --------------------------------------------------------------------------- */

/**
 * `prefix` is omitted from the native attributes because the DOM already has a
 * `prefix` attribute typed as `string`, and we need a ReactNode slot instead.
 * `size` is omitted too — the native one is a number, ours would conflict with
 * the CSS-driven sizing.
 */
export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'size'> {
  label?: ReactNode;
  error?: string;
  hint?: string;
  /** 标签行右侧的附属内容（如密码框旁的「忘记密码？」链接） */
  labelExtra?: ReactNode;
  /** 左侧图标 */
  prefix?: ReactNode;
  /** 右侧内容（按钮等）*/
  suffix?: ReactNode;
  /** 撑满宽度，默认 true */
  block?: boolean;
  /** 等宽字体（IP、路径、UUID 等）*/
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    error,
    hint,
    labelExtra,
    prefix,
    suffix,
    block = true,
    mono = false,
    className,
    id,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      required={rest.required}
      htmlFor={inputId}
      labelExtra={labelExtra}
    >
      <div
        className={`input-wrap ${block ? 'input-block' : ''} ${
          error ? 'is-invalid' : ''
        }`}
      >
        {prefix ? <span className="input-prefix">{prefix}</span> : null}
        <input
          ref={ref}
          id={inputId}
          className={`input ${mono ? 'mono' : ''} ${className ?? ''}`}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        {suffix ? <span className="input-suffix">{suffix}</span> : null}
      </div>
    </Field>
  );
});

/* ---------------------------------------------------------------------------
   Textarea
   --------------------------------------------------------------------------- */

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: string;
  hint?: string;
  /** 等宽字体（SSH Key / JSON 等）*/
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { label, error, hint, mono = false, className, id, rows = 4, ...rest },
    ref,
  ) {
    const autoId = useId();
    const inputId = id ?? autoId;

    return (
      <Field
        label={label}
        error={error}
        hint={hint}
        required={rest.required}
        htmlFor={inputId}
      >
        <textarea
          ref={ref}
          id={inputId}
          rows={rows}
          className={`textarea ${mono ? 'mono' : ''} ${
            error ? 'is-invalid' : ''
          } ${className ?? ''}`}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
      </Field>
    );
  },
);

/* ---------------------------------------------------------------------------
   Select
   --------------------------------------------------------------------------- */

export interface SelectOptionItem {
  label: string;
  value: string | number;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  error?: string;
  hint?: string;
  /** 选项数组 */
  options?: SelectOptionItem[];
  /** 未选择时的占位（应配合 value='' 使用）*/
  placeholder?: string;
  children?: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    {
      label,
      error,
      hint,
      options,
      placeholder,
      children,
      className,
      id,
      ...rest
    },
    ref,
  ) {
    const autoId = useId();
    const selectId = id ?? autoId;

    return (
      <Field
        label={label}
        error={error}
        hint={hint}
        required={rest.required}
        htmlFor={selectId}
      >
        <div className={`select-wrap ${error ? 'is-invalid' : ''}`}>
          <select
            ref={ref}
            id={selectId}
            className={`select ${className ?? ''}`}
            aria-invalid={error ? true : undefined}
            {...rest}
          >
            {placeholder ? <option value="">{placeholder}</option> : null}
            {options
              ? options.map((o) => (
                  <option key={String(o.value)} value={o.value} disabled={o.disabled}>
                    {o.label}
                  </option>
                ))
              : children}
          </select>
          <span className="select-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="m6 9 6 6 6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </Field>
    );
  },
);

/* ---------------------------------------------------------------------------
   Switch（开关）
   --------------------------------------------------------------------------- */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  hint?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /**
   * 无障碍名称。不传 label 时（例如「左侧说明文字 + 右侧开关」的设置行，
   * 文字与开关是分开的两个元素）用它保证读屏能念出这个开关是干什么的。
   */
  ariaLabel?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  id,
  className,
  ariaLabel,
}: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;

  return (
    <div className={`switch-field ${disabled ? 'is-disabled' : ''} ${className ?? ''}`}>
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        className={`switch ${checked ? 'is-on' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
      {label ? (
        <span className="switch-content">
          <label className="switch-label" htmlFor={switchId}>
            {label}
          </label>
          {hint ? <span className="switch-hint">{hint}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Checkbox
   --------------------------------------------------------------------------- */

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  /** 中间态（批量选择）*/
  indeterminate?: boolean;
}

export function Checkbox({
  label,
  indeterminate = false,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const autoId = useId();
  const cbId = id ?? autoId;

  return (
    <label className={`checkbox-field ${className ?? ''}`} htmlFor={cbId}>
      <input
        type="checkbox"
        id={cbId}
        ref={(el) => {
          if (el) el.indeterminate = indeterminate;
        }}
        className="checkbox-input"
        {...rest}
      />
      <span className="checkbox-box" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="11" height="11">
          {indeterminate ? (
            <path
              d="M3.5 8h9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          ) : (
            <path
              d="M3 8.5 6.2 11.7 13 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </span>
      {label ? <span className="checkbox-label">{label}</span> : null}
    </label>
  );
}

/* ---------------------------------------------------------------------------
   RadioGroup
   --------------------------------------------------------------------------- */

export interface RadioOption {
  label: ReactNode;
  value: string;
  hint?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
  /** 竖向排列 */
  vertical?: boolean;
  label?: ReactNode;
}

export function RadioGroup({
  name,
  value,
  onChange,
  options,
  vertical = false,
  label,
}: RadioGroupProps) {
  return (
    <fieldset
      className={`radio-group ${vertical ? 'is-vertical' : ''}`}
      aria-label={typeof label === 'string' ? label : undefined}
    >
      {label ? <legend className="radio-legend">{label}</legend> : null}
      {options.map((o) => (
        <label
          key={o.value}
          className={`radio-field ${o.disabled ? 'is-disabled' : ''}`}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
            className="radio-input"
          />
          <span className="radio-dot" aria-hidden="true" />
          <span className="radio-content">
            <span className="radio-label">{o.label}</span>
            {o.hint ? <span className="radio-hint">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/* ---------------------------------------------------------------------------
   SegmentedControl（分段切换，替代 tab）
   --------------------------------------------------------------------------- */

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ label: ReactNode; value: T }>;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={`segmented ${className ?? ''}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={`segmented-item ${value === o.value ? 'is-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
