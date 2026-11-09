import { ImportError } from './types';

export interface Decoded {
  text: string;
  encoding: 'utf-8' | 'gbk' | 'utf-16le';
}

/**
 * 猜编码。顺序是有讲究的：
 *   1. BOM 最可信，先看
 *   2. 再试「严格 UTF-8」—— 合法 UTF-8 的字节序列很难被 GBK 文本误判，
 *      反过来 GBK 文本几乎必然在 UTF-8 下报错。所以「能严格解开」就基本是 UTF-8
 *   3. 都不行就是 GBK（支付宝账单就是 GBK，微信是带 BOM 的 UTF-8）
 *
 * 不用嗅探库：真实场景只有这两种，多一层依赖不值得。
 */
export function decodeBytes(bytes: Uint8Array): Decoded {
  if (bytes.length === 0) throw new ImportError('EMPTY_FILE', '文件是空的，没有任何内容。');

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }

  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    return { text: strict.decode(bytes), encoding: 'utf-8' };
  } catch {
    /* 不是合法 UTF-8，往下走 GBK */
  }

  try {
    return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' };
  } catch {
    throw new ImportError(
      'UNKNOWN_ENCODING',
      '这个文件的编码既不是 UTF-8 也不是 GBK。请在 Excel 里另存为「CSV UTF-8」后再导入。',
    );
  }
}
