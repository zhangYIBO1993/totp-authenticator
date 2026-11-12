#!/usr/bin/env node
/* totp-authenticator.html 逻辑自检（无框架）：node test-totp.mjs
 * 覆盖：RFC 向量 / otpauth 往返 / v3 明文存储 / v1·v2 迁移（成功+失败不覆盖）/ GA 迁移链接解码 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { deflateRawSync, deflateSync } from 'node:zlib';

const html = readFileSync(new URL('./totp-authenticator.html', import.meta.url), 'utf8');
const js = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const core = js.slice(0, js.indexOf('/* ---------------- 事件绑定与启动'));

const elS = () => ({ addEventListener(){}, classList:{add(){},remove(){},toggle(){}}, style:{}, innerHTML:'', textContent:'' });
const docS = new Proxy({}, { get: () => () => elS() });
const b64e = s => Buffer.from(s, 'binary').toString('base64');
const b64d = s => Buffer.from(s, 'base64').toString('binary');

function makeApi(overrides = {}) {
  const store = new Map();
  const ls = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const nav = { userAgent: 'ua-test', language: 'zh-CN', hardwareConcurrency: 8, platform: 'MacIntel', ...overrides.navigator };
  const scr = { width: 1920, height: 1080, colorDepth: 30, ...overrides.screen };
  const api = new Function(
    'localStorage', 'document', 'window', 'crypto', 'navigator', 'screen', 'setInterval', 'alert', 'btoa', 'atob',
    core + '\nreturn { base32Decode, base32Encode, hotp, totpAt, parseOtpauth, buildOtpauth, saveAccounts, loadAccounts, parseMigration, isLegacyLocked: () => legacyLocked };'
  )(ls, docS, { crypto: webcrypto }, webcrypto, nav, scr, () => {}, m => { throw new Error('unexpected alert: ' + m); }, b64e, b64d);
  return { api, store };
}

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); if (!cond) console.error('FAIL:', name); };

// 1. RFC 4226 / 6238 向量
{
  const { api } = makeApi();
  const key = api.base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const vec = ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'];
  check('RFC4226 HOTP 向量', vec.every((v, i) => api.hotp(key, i) === v));
  check('RFC6238 TOTP 向量', api.totpAt(key, 59, 30, 8) === '94287082');
}

// 2. Base32 编解码往返 & otpauth 往返
{
  const { api } = makeApi();
  const s = 'JBSWY3DPEHPK3PXP';
  check('base32 编解码往返', api.base32Encode(api.base32Decode(s)) === s);
  const uri = 'otpauth://totp/GitHub:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
  const p = api.parseOtpauth(uri);
  check('otpauth 解析', p.issuer === 'GitHub' && p.label === 'user@example.com' && p.digits === 6);
  const p2 = api.parseOtpauth(api.buildOtpauth(p));
  check('otpauth 构造往返', p2.issuer === p.issuer && p2.label === p.label && p2.secret === p.secret);
}

// 3. v3 明文存取
{
  const { api, store } = makeApi();
  const accs = [{ id: 'a', label: 'u@x.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, createdAt: 1 }];
  await api.saveAccounts(accs);
  const saved = JSON.parse(store.get('totp-authenticator-store-v3'));
  check('v3 明文保存', saved.v === 3 && Array.isArray(saved.accounts) && saved.accounts[0].secret === 'JBSWY3DPEHPK3PXP');
  check('v3 读取', (await api.loadAccounts()).length === 1);
}

// 4. v1 明文 → v3 迁移
{
  const { api, store } = makeApi();
  store.set('totp-accounts', JSON.stringify([{ label: 'old', issuer: '', secret: 'MFRGGZDFMZTWQ2LK', digits: 6, period: 30 }]));
  const arr = await api.loadAccounts();
  check('v1 迁移到 v3', arr.length === 1 && arr[0].label === 'old'
    && store.get('totp-authenticator-store-v3') && !store.has('totp-accounts'));
}

// 5. v2 密文 → v3 迁移（同指纹成功）
async function craftV2(fpNav, fpScr, accs) {
  const fp = [fpNav.userAgent, fpNav.language,
    `${fpScr.width}x${fpScr.height}x${fpScr.colorDepth}`,
    -480, fpNav.hardwareConcurrency, fpNav.platform].join('|');
  const salt = new Uint8Array(16); webcrypto.getRandomValues(salt);
  const iv = new Uint8Array(12); webcrypto.getRandomValues(iv);
  const base = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(fp));
  const km = await webcrypto.subtle.importKey('raw', base, 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(accs))));
  return JSON.stringify({ v: 2, salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'), data: Buffer.from(ct).toString('base64') });
}
{
  const nav = { userAgent: 'ua-test', language: 'zh-CN', hardwareConcurrency: 8, platform: 'MacIntel' };
  const scr = { width: 1920, height: 1080, colorDepth: 30 };
  const accs = [{ id: 'a', label: 'u@x.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, createdAt: 1 }];
  const blob = await craftV2(nav, scr, accs);

  const ok = makeApi();
  ok.store.set('totp-authenticator-store-v2', blob);
  ok.store.set('totp-authenticator-salt', '"x"');
  const arr = await ok.api.loadAccounts();
  check('v2 密文迁移成功', arr.length === 1 && arr[0].secret === 'JBSWY3DPEHPK3PXP'
    && !ok.store.has('totp-authenticator-store-v2') && ok.store.has('totp-authenticator-store-v3'));

  const bad = makeApi({ navigator: { userAgent: 'CHANGED' } });
  bad.store.set('totp-authenticator-store-v2', blob);
  const empty = await bad.api.loadAccounts();
  check('v2 解密失败返回空', empty.length === 0 && bad.api.isLegacyLocked());
  await bad.api.saveAccounts([{ id: 'n', label: 'new', issuer: '', secret: 'MFRGGZDFMZTWQ2LK', digits: 6, period: 30, createdAt: 2 }]);
  check('失败后保存不销毁 v2 原数据', bad.store.get('totp-authenticator-store-v2') === blob);
}

// 6. GA 迁移链接解码
{
  const { api } = makeApi();
  const enc = new TextEncoder();
  const varint = v => { const out = []; let x = v; do { let b = x & 0x7f; x = Math.floor(x / 128); if (x) b |= 0x80; out.push(b); } while (x); return out; };
  const lenDelim = (field, bytes) => [field << 3 | 2, ...varint(bytes.length), ...bytes];
  const secretBytes = [...api.base32Decode('JBSWY3DPEHPK3PXP')];
  const e1 = [ // GitHub:user@example.com / issuer=GitHub / TOTP / 6位
    ...lenDelim(1, secretBytes),
    ...lenDelim(2, enc.encode('GitHub:user@example.com')),
    ...lenDelim(3, enc.encode('GitHub')),
    4 << 3, 2, 6 << 3, 6,
  ];
  const e2 = [ // name 带「阿里云:」前缀、无 issuer 字段 → 靠 name 切分；8 位
    ...lenDelim(1, secretBytes),
    ...lenDelim(2, enc.encode('阿里云:ops@corp')),
    4 << 3, 2, 6 << 3, 8,
  ];
  const e3 = [ // HOTP → 跳过
    ...lenDelim(1, secretBytes),
    ...lenDelim(2, enc.encode('hotp:x')),
    4 << 3, 1,
  ];
  const payload = [...lenDelim(1, e1), ...lenDelim(1, e2), ...lenDelim(1, e3), 2 << 3, 1]; // 顶层 version 字段
  const toB64url = buf => Buffer.from(buf).toString('base64url');

  const raw = await api.parseMigration('otpauth-migration://offline?data=' + toB64url(deflateRawSync(Buffer.from(payload))));
  check('GA raw-deflate 解码', raw.items.length === 2 && raw.skippedHotp === 1);
  check('GA 条目1 issuer 字段', raw.items[0].issuer === 'GitHub' && raw.items[0].label === 'user@example.com' && raw.items[0].digits === 6);
  check('GA 条目2 name 切分', raw.items[1].issuer === '阿里云' && raw.items[1].label === 'ops@corp' && raw.items[1].digits === 8);
  check('GA secret 还原', raw.items[0].secret === 'JBSWY3DPEHPK3PXP');

  const zlibWrapped = await api.parseMigration('otpauth-migration://offline?data=' + toB64url(deflateSync(Buffer.from(payload))));
  check('GA zlib 头兼容', zlibWrapped.items.length === 2);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED / ${results.length}` : `all ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
