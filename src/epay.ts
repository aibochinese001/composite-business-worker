import { md5 } from './lib';

// 易支付 (EasyPay) integration — signature + order param builder.
// Reference formula (verified against PayOne): ksort → k=v& → rtrim(&) → +rawkey → md5 lowercase

export type EpayConfig = {
  apiUrl: string;
  pid: string;
  key: string;
};

export function epaySign(params: Record<string, string | number>, key: string): string {
  const p: Record<string, string> = {};
  for (const k of Object.keys(params)) {
    if (k === 'sign' || k === 'sign_type') continue;
    const v = params[k];
    if (v === '' || v === null || v === undefined) continue;
    p[k] = String(v);
  }
  const sorted = Object.keys(p).sort();
  let str = '';
  for (const k of sorted) str += `${k}=${p[k]}&`;
  str = str.slice(0, -1); // rtrim '&'
  str += key; // raw key, no "key=" prefix
  return md5(str).toLowerCase();
}

export function normalizeApiUrl(url: string): string {
  let u = url.trim();
  if (!u) return '';
  // ensure /submit.php suffix
  if (!/\/submit\.php$/i.test(u)) {
    u = u.replace(/\/+$/, '') + '/submit.php';
  }
  return u;
}

export type OrderParams = {
  pid: string;
  type: string; // wxpay | alipay | usdt
  out_trade_no: string;
  notify_url: string;
  return_url: string;
  name: string;
  money: string;
  sign: string;
  sign_type: string;
  [k: string]: string;
};

export function buildOrderParams(
  cfg: EpayConfig,
  args: {
    type: string;
    outTradeNo: string;
    notifyUrl: string;
    returnUrl: string;
    name: string;
    money: string;
  }
): OrderParams {
  const base: Record<string, string> = {
    pid: cfg.pid,
    type: args.type,
    out_trade_no: args.outTradeNo,
    notify_url: args.notifyUrl,
    return_url: args.returnUrl,
    name: args.name,
    money: args.money,
  };
  const sign = epaySign(base, cfg.key);
  return { ...base, sign, sign_type: 'MD5' } as OrderParams;
}

export function verifyCallbackSign(
  params: Record<string, string | number>,
  key: string,
  signToCheck: string
): boolean {
  const computed = epaySign(params, key);
  return computed.toLowerCase() === String(signToCheck).toLowerCase();
}
