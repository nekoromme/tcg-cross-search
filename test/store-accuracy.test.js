import test from 'node:test';
import assert from 'node:assert/strict';
import { findCandidateProducts } from '../src/search-results.js';
import { describeSearchEvidence, selectRows } from '../public/ui.js';
import worker from '../src/index.js';

// マスターズスクウェアの実ページで見た、検索語をspanで強調する形を最小限に再現。
const singles = '<a href="/product/97595">ムラサメ[GCG_ <span>GD05</span> -003_R(2)] 【Freedom Ascension収録】</a>' +
  '<a href="/product/97595"><img alt="ムラサメ[GCG_GD05-003_R(2)]"></a>';

test('listing evidence separates singles, unrelated products and unreadable pages', () => {
  const stats = {};
  assert.deepEqual(findCandidateProducts(singles, 'https://shop.test/', 'GD05', true, 8, true, stats), []);
  assert.equal(stats.excludedSingles, 1, '同じ商品の画像と商品名で件数を水増ししない');
  assert.match(describeSearchEvidence({status:'no_hit',coverage:{listing:stats}}), /シングル等を除外/);
  assert.match(describeSearchEvidence({status:'no_hit',coverage:{listing:{productLinks:2}}}), /検索語に一致する候補なし/);
  assert.match(describeSearchEvidence({status:'no_hit',coverage:{listing:{productLinks:0}}}), /ページ構造の違いは手動確認/);
  assert.equal(describeSearchEvidence({status:'blocked',coverage:{listing:stats}}), '');
});

test('script templates and commented products never become cheap BOX offers', () => {
  const html = '<script type="text/template"><a href="/product/1">GD05 BOX 100円 在庫あり</a></script>' +
    '<!-- <a href="/product/2">GD05 BOX 200円 在庫あり</a> -->' +
    '<a href="/product/3">GD05 BOX</a><p>6000円 在庫あり</p>';
  const rows = findCandidateProducts(html, 'https://shop.test/', 'GD05', true, 8);
  assert.deepEqual(rows.map(r => r.url), ['https://shop.test/product/3']);
});

test('single-dominated searches use just one BOX fallback and verify its result', async t => {
  const urls=[];
  t.mock.method(globalThis, 'fetch', async url => {
    const u=new URL(url); urls.push(u);
    if (u.pathname === '/product/8') return new Response('<h1>GD05 BOX</h1><p>販売価格:6000円 在庫数 2</p>');
    if (u.searchParams.get('keyword') === 'GD05 BOX') return new Response('<a href="/product/8">GD05 BOX</a>');
    return new Response(singles);
  });
  const data = await (await worker.fetch(new Request('https://app.test/api/search?store=masters_gundam&q=GD05'), {})).json();
  assert.deepEqual(urls.filter(u=>u.pathname==='/product-list').map(u=>u.searchParams.get('keyword')), ['GD05','GD05 BOX']);
  assert.equal(data.coverage.fallback,'box_keyword');
  assert.equal(data.coverage.requests,3);
  assert.equal(data.results[0].comparison.status,'known');
  assert.equal(selectRows(new Map([['a',data]])).main[0].price,6000);
});

test('BOX fallback does not cascade to further aliases after no hit or rejection', async t => {
  const urls=[];
  const mock=t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url)); return new Response(singles);});
  const request=new Request('https://app.test/api/search?store=masters_gundam&q=GD05');
  const data=await (await worker.fetch(request,{})).json();
  assert.equal(data.status,'no_hit'); assert.equal(urls.length,2);
  urls.length=0;
  mock.mock.mockImplementation(async url=>{urls.push(String(url)); return new Response('denied',{status:429});});
  assert.equal((await (await worker.fetch(request,{})).json()).status,'blocked');
  assert.equal(urls.length,1);
});

test('stores without verified multiword search retain the existing alias fallback', async t => {
  const terms=[];
  t.mock.method(globalThis,'fetch',async url=>{terms.push(new URL(url).searchParams.get('name'));return new Response(singles);});
  const data=await (await worker.fetch(new Request('https://app.test/api/search?store=193&q=GD05'),{})).json();
  assert.deepEqual(terms,['GD05','Freedom Ascension']);
  assert.equal(data.coverage.fallback,'alias');
});
