// 公式価格と入数の出典を確認した商品だけを追加する。未登録の商品へ価格を推測しない。
export const CATALOG_UPDATED = '2026-09-07';
const source = (label, url) => ({ label, url });
const official = url => source('公式商品情報', url);
const box = url => source('公式BOX価格・仕様', url);
const count = url => source('BOX入数の確認元', url);
function entry(game, code, name, releaseDate, boxPrice, basis, sources, extra = {}) {
  return { id: `${game}-${code.toLowerCase()}`, game, code, name, releaseDate, boxPrice, basis, sources,
    checkedAt: CATALOG_UPDATED, language: 'ja', aliases: [name, ...(extra.aliases || [])],
    searchTerm: code, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'aliases')) };
}
const gundam = 'https://www.gundam-gcg.com/jp/products/';
const pokemon = 'https://www.pokemon-card.com/ex/';
const center = 'https://www.pokemoncenter-online.com/';
const onepiece = 'https://www.onepiece-cardgame.com/';
const dragonball = 'https://www.dbs-cardgame.com/fw/jp/';
const squareCount = count('https://www.masters-square.com/pickup');
export const PRODUCTS = [
  entry('pokemon', 'M6', 'ストームエメラルダ', '2026-07-31', 6000, 'pack_times_count',
    [official(pokemon+'m6/'), count(center+'9900000008109.html')], { packPrice:200, packsPerBox:30, searchTerm:'ストームエメラルダ' }),
  entry('pokemon', 'M5', 'アビスアイ', '2026-05-22', 6000, 'pack_times_count',
    [official(pokemon+'m5/'), count(center+'9900000007904.html')], { packPrice:200, packsPerBox:30, searchTerm:'アビスアイ' }),
  entry('pokemon', 'M4', 'ニンジャスピナー', '2026-03-13', 5400, 'official_box',
    [official(pokemon+'m4/'), box(center+'9900000007898.html')], { searchTerm:'ニンジャスピナー' }),
  entry('pokemon', 'M3', 'ムニキスゼロ', '2026-01-23', 5400, 'official_box',
    [official(pokemon+'m3/'), box(center+'9900000007003.html')], { searchTerm:'ムニキスゼロ' }),
  entry('pokemon', 'M2a', 'MEGAドリームex', '2025-11-28', 5500, 'official_box',
    [official(pokemon+'m2a/index.html'), box(center+'9900000006808.html')], { searchTerm:'MEGAドリームex', aliases:['メガドリームex'] }),
  entry('pokemon', 'SV8a', 'テラスタルフェスex', '2024-12-06', 5500, 'official_box',
    [official(pokemon+'sv8a/index.html'), box(center+'9900000006167.html')], { searchTerm:'テラスタルフェスex' }),
  entry('onepiece', 'OP-15', '神の島の冒険', '2026-02-28', 5280, 'official_box',
    [official(onepiece+'products/boosters/op15.php'), box(onepiece+'events/2026/officialevents/release-event-op15/')]),
  entry('onepiece', 'OP-16', '決戦の刻', '2026-05-30', 5280, 'official_box',
    [official(onepiece+'products/op16.html'), box(onepiece+'events/release-event-op16.html')]),
  entry('onepiece', 'OP-17', '世界最強の戦士', '2026-08-22', 5760, 'official_box',
    [official(onepiece+'products/op17.html'), box(onepiece+'events/release-event-op17.html')]),
  entry('gundam', 'GD01', 'Newtype Rising', '2025-07-26', 5808, 'official_box',
    [official(gundam+'gd01.html'), box('https://p-bandai.jp/item/item-1000253504/')], { aliases:['ニュータイプライジング'] }),
  entry('gundam', 'GD02', 'Dual Impact', '2025-10-25', 5808, 'official_box',
    [official(gundam+'gd02.html'), box('https://p-bandai.jp/item/item-1000253505/')], { aliases:['デュアルインパクト'] }),
  entry('gundam', 'GD03', 'Steel Requiem', '2026-01-31', 5808, 'pack_times_count',
    [official(gundam+'gd03.html'), count('https://www.target.co.jp/view/item/000000020837')], { packPrice:242, packsPerBox:24, aliases:['スティールレクイエム'] }),
  entry('gundam', 'GD04', 'Phantom Aria', '2026-04-25', 5808, 'pack_times_count',
    [official(gundam+'gd04.html'), squareCount], { packPrice:242, packsPerBox:24, aliases:['ファントムアリア'] }),
  entry('gundam', 'EB01', 'Eternal Nexus', '2026-06-27', 5808, 'pack_times_count',
    [official(gundam+'eb01.html'), squareCount], { packPrice:242, packsPerBox:24, searchTerm:'Eternal Nexus', ambiguousCode:true, aliases:['エターナルネクサス'] }),
  entry('gundam', 'GD05', 'Freedom Ascension', '2026-07-25', 6000, 'pack_times_count',
    [official(gundam+'gd05.html'), count('https://p-bandai.jp/item/item-1000254964/')], { packPrice:250, packsPerBox:24, aliases:['フリーダムアセンション','Freedom Acsension'] }),
  entry('dragonball', 'FB09', 'DUAL EVOLUTION', '2026-03-14', 5280, 'official_box',
    [official(dragonball+'products/01_343.html'), box(dragonball+'events/01_370.html')]),
  entry('dragonball', 'FB10', 'CROSS FORCE', '2026-06-13', 5280, 'official_box',
    [official(dragonball+'products/01_400.html'), box(dragonball+'events/01_424.html')]),
  entry('dragonball', 'FB11', 'BRIGHTNESS OF HOPE', '2026-09-12', 5760, 'official_box',
    [official(dragonball+'products/01_422.html'), box(dragonball+'events/01_495.html')]),
  entry('dragonball', 'ST01', 'STORY BOOSTER 01', '2026-08-08', 6600, 'pack_times_count',
    [official(dragonball+'products/01_401.html'), count('https://p-bandai.jp/item/item-1000255641/')],
    { packPrice:330, packsPerBox:20, searchTerm:'STORY BOOSTER 01', ambiguousCode:true, aliases:['ストーリーブースター01'] }),
  ...[
    ['the-first-chapter','物語のはじまり','2025-01-25',['The First Chapter']],
    ['rise-of-the-floodborn','フラッドボーンの渾沌','2025-03-22',['Rise of the Floodborn','フラッドボーンの混沌']],
    ['into-the-inklands','インクランド探訪','2025-05-17',['Into the Inklands']],
    ['ursulas-return','逆襲のアースラ','2025-07-12',["Ursula’s Return","Ursula's Return"]],
    ['shimmering-skies','星々の輝き','2025-09-06',['Shimmering Skies']],
    ['azurite-sea','大いなるアズライト','2025-10-31',['Azurite Sea']],
    ['archazias-island','アーケイジアと魔法の島','2025-12-27',["Archazia's Island","Archazias Island"]],
    ['reign-of-jafar','ジャファーの王権','2026-02-21',['Reign of Jafar']],
    ['wilds-unknown','未知なる彼方へ!','2026-05-08',['Wilds Unknown','未知なる彼方へ']],
    ['attack-of-the-vine','ヴァインズ・アタック！','2026-07-17',['Attack of the Vine','ヴァインズ・アタック']],
    ['hyperia-city','ハイペリアシティ','2026-10-16',['Hyperia City','ハイぺリアシティ']],
  ].map(([slug,name,release,aliases]) => ({
    ...entry('lorcana', slug, name, release, 5280, 'official_box',
      [box(`https://www.takaratomy.co.jp/products/disneylorcana/product/${slug}/booster-pack/`)],
      { packPrice:330, packsPerBox:16, aliases, searchTerm:name }), code:''
  })),
];
