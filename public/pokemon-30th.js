import {isPokemon30thTitle,isSpecialSet,productKind} from './product-kind.js';

// JANだけでは販売単位を確定できないため、JAN単独や価格でBOX認定しない。
// 商品自身の見出し・構造化データと明示された1BOX入数だけを使う。
export function pokemon30thBoxIdentity(row) {
  const title=String(row?.title||'').normalize('NFKC');
  if(!isPokemon30thTitle(title))return null;
  const base={productId:'pokemon-m6a',version:1};
  if(isSpecialSet(title))return {...base,status:'excluded',reason:'カードセット・特別商品は通常拡張BOXと別商品'};
  if(/英語版|海外版|中国語|韓国語|繁体|繁體|簡体|简体|english|\bEN\b|中古|開封済|空[き]?箱/i.test(title))
    return {...base,status:'excluded',reason:'通常の日本語版新品BOXではない'};
  const kind=productKind(title);
  if(kind!=='box')return {...base,status:kind==='unknown'?'uncertain':'excluded',reason:'日本語版1BOXの販売単位を確認できず'};
  const titleCount=title.match(/(\d+)\s*(?:パック|packs?)(?:入り|入|\b|[)）])/i)?.[1];
  const count=Number(row.packsPerBox||titleCount)||null;
  if(count&&count!==20)return {...base,status:'excluded',reason:`通常BOXの20パック仕様と不一致（${count}パック）`};
  if(row.productIdentity?.productId==='pokemon-m6a'&&row.productIdentity.status!=='confirmed')return row.productIdentity;
  return {...base,status:'confirmed',reason:count?'通常拡張BOX・20パック仕様を確認':'通常拡張商品の1BOX表記を確認',...(count?{packsPerBox:count}:{})};
}

export function explicitPacksPerBox(text) {
  const value=String(text||'').normalize('NFKC');
  const matches=[...value.matchAll(/1\s*(?:BOX|ボックス|箱)\s*(?:[=＝:：/／、・]|には|あたり|当たり)?\s*(\d+)\s*(?:パック|packs?)/gi)];
  const counts=[...new Set(matches.map(m=>Number(m[1])))];
  return counts.length===1?counts[0]:counts.length>1?-1:null;
}
