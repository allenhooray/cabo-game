export function CountdownLabel(props: { seconds: number; variant: "compact" | "message"; className: string; as?: "span" | "div"; ariaLabel?: string; message?: string }) {
  const Element = props.as ?? "span";
  return <Element className={props.className} role="timer" {...(props.ariaLabel === undefined ? {} : { "aria-label": props.ariaLabel })}>{props.variant === "compact" ? `${props.seconds}s` : props.message}</Element>;
}
