import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost"; size?: "default" | "small" }>(function Button({ variant = "default", size = "default", className = "", type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={["button", variant !== "default" && variant, size !== "default" && size, className].filter(Boolean).join(" ")} {...props} />;
});

export const TextButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function TextButton({ className = "", type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={["text-button", className].filter(Boolean).join(" ")} {...props} />;
});

export function Field(props: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return <label className="field-label" {...(props.htmlFor === undefined ? {} : { htmlFor: props.htmlFor })}>{props.label}{props.hint && <> <span>{props.hint}</span></>}{props.children}</label>;
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className = "", ...props }, ref) {
  return <input ref={ref} className={["input", className].filter(Boolean).join(" ")} {...props} />;
});

export const SelectField = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function SelectField({ className = "", ...props }, ref) {
  return <select ref={ref} className={["input", className].filter(Boolean).join(" ")} {...props} />;
});

export function SegmentedControl<T extends string>(props: { label: string; value: T; options: ReadonlyArray<readonly [T, ReactNode]>; onChange(value: T): void }) {
  return <div className="segmented" aria-label={props.label}>{props.options.map(([value, label]) => <button key={value} type="button" aria-pressed={props.value === value} onClick={() => props.onChange(value)}>{label}</button>)}</div>;
}
