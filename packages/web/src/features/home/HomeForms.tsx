import type { FormEvent } from "react";
import type { MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";
import { useTranslation } from "react-i18next";
import type { readInvitation } from "../../invitation.js";
import { Button, Field, SegmentedControl, SelectField, TextInput } from "../../components/FormControls.js";

export function CreateRoomForm(props: {
  busy: boolean;
  visibility: "public" | "private";
  targetScore: number;
  roomName: string;
  memoryMode: MemoryMode;
  turnDurationSeconds: TurnDurationSeconds;
  password: string;
  onVisibility(value: "public" | "private"): void;
  onTargetScore(value: number): void;
  onRoomName(value: string): void;
  onMemoryMode(value: MemoryMode): void;
  onTurnDuration(value: TurnDurationSeconds): void;
  onPassword(value: string): void;
  onSubmit(): void;
}) {
  const { t } = useTranslation();
  return <form id="create-room-form" className="inline-form" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
    <SegmentedControl label={t("home.roomVisibility")} value={props.visibility} options={[["public", t("home.public")], ["private", t("home.private")]]} onChange={props.onVisibility} />
    <div className="create-fields create-fields-primary">
      <Field label={t("home.roomName")} hint={t("home.roomNameHint")} htmlFor="create-room-name"><TextInput id="create-room-name" value={props.roomName} onChange={(event) => props.onRoomName(event.target.value)} /></Field>
      <Field label={t("home.targetScore")}><TextInput type="number" min={20} max={500} value={props.targetScore} onChange={(event) => props.onTargetScore(Number(event.target.value))} /></Field>
    </div>
    <div className="create-fields">
      <Field label={t("home.memoryMode")}><SelectField value={props.memoryMode} onChange={(event) => props.onMemoryMode(event.target.value as MemoryMode)}><option value="classic">{t("home.classic")}</option><option value="assisted">{t("home.assisted")}</option></SelectField></Field>
      <Field label={t("home.stepTimer")}><SelectField value={props.turnDurationSeconds} onChange={(event) => props.onTurnDuration(Number(event.target.value) as TurnDurationSeconds)}>{[0, 30, 60, 90].map((seconds) => <option key={seconds} value={seconds}>{seconds ? t("common.seconds", { count: seconds }) : t("home.unlimited")}</option>)}</SelectField></Field>
    </div>
    {props.visibility === "private" && <Field label={t("home.passwordSix")}><TextInput inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={props.password} onChange={(event) => props.onPassword(event.target.value.replace(/\D/g, ""))} /></Field>}
    <Button variant="primary" type="submit" disabled={props.busy || Array.from(props.roomName.trim()).length > 40 || props.targetScore < 20 || props.targetScore > 500 || (props.visibility === "private" && !/^\d{6}$/.test(props.password))}>{t("home.createTable")}</Button>
  </form>;
}

export function JoinRoomForm(props: {
  invitation: ReturnType<typeof readInvitation>;
  busy: boolean;
  roomCode: string;
  password: string;
  onRoomCode(value: string): void;
  onPassword(value: string): void;
  onSubmit(): void;
}) {
  const { t } = useTranslation();
  return <form id="join-room-form" className="inline-form" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!props.invitation?.error) props.onSubmit(); }}>
    {props.invitation && <p role={props.invitation.error ? "alert" : undefined}>{t("home.invitationServer")} <strong>{props.invitation.server}</strong>{props.invitation.error ? ` — ${props.invitation.error}` : ` — ${t("home.invitationConfirm")}`}</p>}
    <Field label={t("home.roomCode")}><TextInput className="code-input" autoCapitalize="none" value={props.roomCode} onChange={(event) => props.onRoomCode(event.target.value)} /></Field>
    <Field label={t("home.password")} hint={t("home.optional")}><TextInput inputMode="numeric" maxLength={6} value={props.password} onChange={(event) => props.onPassword(event.target.value.replace(/\D/g, ""))} /></Field>
    <Button variant="primary" type="submit" disabled={props.busy || !props.roomCode.trim() || Boolean(props.invitation?.error)}>{t("home.joinTable")}</Button>
  </form>;
}
