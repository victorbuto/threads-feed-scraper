#!/usr/bin/env node
/**
 * Сбор постов Threads по ключевым словам в готовую таблицу.
 *
 * Запуск:
 *   node scripts/collect.mjs "вайбкодинг" "вайб-кодинг" "vibecoding"
 *   node scripts/collect.mjs --days 14 "нейросети" "ai-агенты"
 *
 * Делает три вещи, которые раньше приходилось делать руками: пишет задание
 * для скрапера, запускает его, а потом сводит 150+ отдельных JSON в CSV и MD.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = path.join(ROOT, 'storage/datasets/default');
const INPUT = path.join(ROOT, 'storage/key_value_stores/default/INPUT.json');
const EXPORTS = path.join(ROOT, 'exports');

// --- разбор аргументов ---------------------------------------------------
const argv = process.argv.slice(2);
let days = 30;
let fetch = true;               // --no-fetch: пересобрать таблицу из уже скачанного
const keywords = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]);
    else if (argv[i] === '--no-fetch') fetch = false;
    else keywords.push(argv[i]);
}
if (!keywords.length) {
    console.error('Укажи хотя бы одно ключевое слово.\n  node scripts/collect.mjs "вайбкодинг" "vibecoding"');
    process.exit(1);
}

/** Убирает дефисы, пробелы и решётки — чтобы «вайб-кодинг» и «вайбкодинг» считались одним словом. */
const norm = (s) => (s || '').toLowerCase().replace(/[\s\-–—#_.,!?:;()"'«»]/g, '');
/** Обрезает окончание, чтобы «вайбкодинг» ловил ещё и «навайбкодив», «вайбкодеры». */
const stem = (s) => { const n = norm(s); return n.length >= 8 ? n.slice(0, -3) : n.length >= 6 ? n.slice(0, -2) : n; };
const stems = [...new Set(keywords.map(stem).filter(Boolean))];
/** Пост релевантен, если содержит ключ целиком. Отсекает мусор: «вайбкодинг» не найдётся в «дачний вайбік». */
const isRelevant = (text) => stems.some((st) => norm(text).includes(st));

// --- 1. задание скраперу -------------------------------------------------
if (fetch) {
mkdirSync(path.dirname(INPUT), { recursive: true });
if (existsSync(DATASET)) rmSync(DATASET, { recursive: true, force: true });
writeFileSync(INPUT, JSON.stringify({
    mode: 'search',
    keywords,
    searchSort: 'top',   // recent у Threads сломан: не сортирует по дате и тянет мусор
    maxPosts: 500,
    scrollCount: 8,
}, null, 4));

console.log(`Ищу в Threads: ${keywords.join(', ')}`);

// --- 2. запуск -----------------------------------------------------------
await new Promise((resolve, reject) => {
    const p = spawn('npm', ['run', 'start:dev'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`скрапер упал, код ${code}`))));
});
} else {
    console.log('Пересобираю таблицу из уже скачанного, без обращения к Threads.');
}

// --- 3. сведение в таблицу ----------------------------------------------
if (!existsSync(DATASET)) {
    console.error('\nThreads не отдал ничего. Обычно это shared IP — попробуй позже или через прокси.');
    process.exit(1);
}
const raw = readdirSync(DATASET)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(DATASET, f), 'utf8')));

const posts = [...new Map(raw.map((d) => [d.postId, d])).values()].map((d) => ({
    ...d,
    relevant: isRelevant(d.content),
    engagement: (d.likeCount || 0) + (d.replyCount || 0) + (d.repostCount || 0),
}));

const relevant = posts.filter((p) => p.relevant);
const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
const top = [...relevant].sort((a, b) => b.engagement - a.engagement);
const fresh = relevant.filter((p) => p.publishedAt.slice(0, 10) >= cutoff)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

const today = new Date().toISOString().slice(0, 10);
const slug = keywords[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
mkdirSync(EXPORTS, { recursive: true });
const base = path.join(EXPORTS, `${slug}_${today}`);

// CSV — открывается в Excel, BOM чтобы кириллица не поехала
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const oneLine = (s) => (s || '').split(/\s+/).join(' ').trim();
writeFileSync(`${base}.csv`, '﻿' + [
    ['дата', 'автор', 'лайки', 'комменты', 'репосты', 'шеры', 'по_теме', 'текст', 'ссылка', 'ключ'].join(','),
    ...[...posts].sort((a, b) => b.engagement - a.engagement).map((d) => [
        d.publishedAt.slice(0, 10), d.author, d.likeCount, d.replyCount, d.repostCount,
        d.shareCount ?? 0, d.relevant ? 'да' : 'нет', oneLine(d.content), d.postUrl, d.sourceQuery ?? '',
    ].map(esc).join(',')),
].join('\n'));

// MD — для чтения глазами
const card = (d) => `**@${d.author}** · ${d.publishedAt.slice(0, 10)} · ♥${d.likeCount} 💬${d.replyCount} 🔁${d.repostCount}\n\n`
    + `${oneLine(d.content)}\n\n[Открыть пост](${d.postUrl})\n\n---\n\n`;
writeFileSync(`${base}.md`,
    `# Threads: ${keywords[0]}\n\n`
    + `Обновлено: ${today} · Назначение: выгрузка постов Threads по ключевым словам для desk-research · `
    + `Содержание: ${posts.length} уникальных постов, из них ${relevant.length} по теме. `
    + `Запросы: ${keywords.join(', ')}.\n\n`
    + `## Топ по вовлечению (${Math.min(top.length, 40)})\n\n${top.slice(0, 40).map(card).join('')}`
    + `## Свежее, за ${days} дн. с ${cutoff} (${fresh.length})\n\n${fresh.map(card).join('')}`);

// --- отчёт ---------------------------------------------------------------
const byKey = {};
for (const d of posts) byKey[d.sourceQuery ?? '?'] = (byKey[d.sourceQuery ?? '?'] ?? 0) + 1;
console.log(`\nСобрано: ${posts.length} уникальных, по теме ${relevant.length}, свежих за ${days} дн. ${fresh.length}`);
console.log('По ключам:', keywords.map((k) => `${k}=${byKey[k] ?? 0}`).join('  '));
console.log(`\nТаблица: ${base}.csv\nЧтение:  ${base}.md`);
