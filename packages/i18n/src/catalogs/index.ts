import { enUS, type Catalog, type MessageKey } from "./en-US.js";
import { ptBR } from "./pt-BR.js";
import { zhCN } from "./zh-CN.js";
import type { SupportedLocale } from "../locales.js";

const enGB: Catalog = { ...enUS, "home.roomNameHint": "up to 40 characters" };
const enAU: Catalog = { ...enUS, "home.roomNameHint": "up to 40 characters" };
const zhTW: Catalog = {
  ...zhCN,
  "settings.trigger": "設定", "settings.title": "設定", "settings.theme": "主題", "settings.language": "語言", "settings.auto": "跟隨系統", "settings.light": "淺色",
  "home.quickStart": "快速開始", "home.playerName": "玩家名稱", "home.createRoom": "建立房間", "home.joinByCode": "使用代碼加入", "home.public": "公開", "home.private": "私人", "home.roomName": "房間名稱", "home.createTable": "建立牌桌", "home.refresh": "重新整理", "home.serverSettings": "伺服器設定", "home.gameServer": "遊戲伺服器", "chat.message": "訊息", "chat.send": "傳送", "room.copyLink": "複製邀請連結", "room.openSeat": "空位", "game.deck": "牌庫", "game.discard": "棄牌堆", "docs.title": "Cabo 文件", "docs.source": "GitHub 原始碼"
};
const zhHK: Catalog = {
  ...zhTW,
  "settings.auto": "跟隨系統", "home.joinByCode": "以代碼加入", "home.serverSettings": "伺服器設定", "chat.send": "傳送", "room.openSeat": "空位", "docs.title": "Cabo 文件"
};
const ptPT: Catalog = {
  ...ptBR,
  "settings.trigger": "Definições", "settings.title": "Definições", "settings.auto": "Seguir o sistema", "home.playerName": "Nome do jogador", "home.yourName": "O seu nome", "home.createRoom": "Criar sala", "home.joinByCode": "Entrar com código", "home.refresh": "Atualizar", "chat.you": "Tu", "chat.placeholder": "Diz alguma coisa…", "room.copyCode": "Copiar código da sala", "room.start": "Iniciar jogo", "result.back": "Voltar às salas"
};
const ptAO: Catalog = {
  ...ptPT,
  "home.lede": "Uma mesa tranquila em tempo real para duas a cinco pessoas.", "chat.you": "Você", "chat.placeholder": "Diga alguma coisa…"
};

export const catalogs: Readonly<Record<SupportedLocale, Catalog>> = {
  "en-US": enUS, "en-GB": enGB, "en-AU": enAU,
  "zh-CN": zhCN, "zh-TW": zhTW, "zh-HK": zhHK,
  "pt-BR": ptBR, "pt-PT": ptPT, "pt-AO": ptAO,
};

export type { Catalog, MessageKey };
