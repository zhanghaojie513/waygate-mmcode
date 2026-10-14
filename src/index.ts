#!/usr/bin/env node
/**
 * waygate-mmcode —— MiniMax Code 本地反代（命令 `mmcode`）。
 *
 * 读取本机 MiniMax Code 客户端的登录态，在本机提供 Anthropic/OpenAI 兼容的聊天端点。
 *
 * ⚠️ 凭证互斥：MiniMax 同一账号只能有一个有效会话 —— 本工具与官方客户端同账号会互相踢下线。
 * 建议给本工具配专用账号。详见 README。
 */

import { createRequire } from 'node:module';
import { runCli } from 'waygate-core';
import { createMmcodeAdapter } from './adapter.js';

/* 版本从 package.json 读 —— 硬编码会与 npm 发布版本漂移（已踩过：package 升 0.1.2 而 CLI 仍显示 0.1.0）。 */
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const code = await runCli(createMmcodeAdapter(), { version: VERSION });
process.exit(code);
