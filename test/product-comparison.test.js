import test from 'node:test';
import assert from 'node:assert/strict';
import { groupProductRows, comparisonConditions } from '../public/comparison-groups.js';
import { selectRows, renderRows } from '../public/ui.js';

function data(offers) {
  const stores = new Map();
  offers.forEach((offer, i) => {
    const id = offer.storeId || `store${i}`;
    if (!stores.has(id)) stores.set(id, {store:{id,name:id},results:[]});
    stores.get(id).results.push({title:'GD03 BOX',price:5808,stock:'in_stock',detailChecked:true,
      url:`https://shop.test/product/${i}`, ...offer});
  });
  return stores;
}

test('aliases group together but available minimum excludes sold-out and preorder offers', () => {
  const groups = groupProductRows(selectRows(data([
    {title:'Steel Requiem BOX',price:4000,stock:'out_of_stock'},
    {title:'スティールレクイエム BOX',price:5000,stock:'preorder'},
    {price:5808}, {price:6000},
  ])).main);
  assert.equal(groups.length,1);
  assert.equal(groups[0].name,'Steel Requiem');
  assert.equal(groups[0].storeCount,4);
  assert.equal(groups[0].availableStores,2);
  assert.equal(groups[0].minPrice,4000);
  assert.equal(groups[0].availableMinPrice,5808);
  assert.equal(groupProductRows(selectRows(data([{stock:'out_of_stock'}])).main)[0].availableMinPrice,null);
});

test('cartons, foreign editions, bundles, unregistered products and ambiguous codes stay individual', () => {
  const rows = selectRows(data([
    {}, {title:'GD03 カートン'}, {title:'GD03 2BOXセット'}, {title:'英語版 GD03 BOX'},
    {title:'未登録 BOX'}, {title:'未登録 BOX'}, {title:'EB01 BOX'},
    {title:'GD04 BOX'}, {title:'GD04 Steel Requiem BOX'},
  ]),{unit:'sealed'}).main;
  const groups = groupProductRows(rows);
  assert.equal(groups.length,9);
  assert.equal(groups.filter(g=>g.comparable).length,2);
});

test('filtered and uncertain prices never influence group summaries or counts', () => {
  const input=data([{price:100,detailChecked:false}, {price:200,stock:'unknown'}, {price:6000}, {price:6500}]);
  const selected=selectRows(input,{maxPrice:6200});
  const groups=groupProductRows(selected.main);
  assert.equal(selected.review.length,2);
  assert.equal(groups[0].availableMinPrice,6000);
  assert.equal(groups[0].storeCount,1);
  assert.equal(groups[0].rows.length,1);
});

test('multiple offers from one store retain conditions without counting as two stores', () => {
  const selected=selectRows(data([
    {storeId:'店A',title:'GD03 BOX シュリンクなし',price:5000},
    {storeId:'店A',title:'GD03 BOX シュリンク付き',price:5808},
    {storeId:'店B',title:'GD03 BOX 店頭受取',price:5500},
  ]));
  const g=groupProductRows(selected.main)[0];
  assert.equal(g.storeCount,2); assert.equal(g.availableStores,2); assert.equal(g.rows.length,3);
  assert.ok(comparisonConditions(g.rows[0]).includes('シュリンクなし・開封条件あり'));
  assert.ok(comparisonConditions(g.rows[2]).includes('シュリンクあり表記'));
  assert.deepEqual(comparisonConditions({title:'GD03 BOX'}),['シュリンク条件未確認']);
});

test('group and offer order follows price, stock or store sorting without changing results', () => {
  const input=data([{title:'GD04 BOX',price:5500}, {price:4000,stock:'out_of_stock'}, {price:5808}]);
  const asc=groupProductRows(selectRows(input,{sort:'price_asc'}).main);
  const desc=groupProductRows(selectRows(input,{sort:'price_desc'}).main);
  const stock=groupProductRows(selectRows(input,{sort:'stock'}).main);
  assert.equal(asc[0].name,'Steel Requiem');
  assert.deepEqual(asc[0].rows.map(r=>r.price),[4000,5808]);
  assert.deepEqual(desc[0].rows.map(r=>r.price),[5808,4000]);
  assert.equal(stock[0].name,'Phantom Aria');
});

test('grouped rendering preserves links, escapes titles, and keeps uncertain candidates separate', () => {
  const input=data([{price:4000,stock:'out_of_stock'}, {}, {price:50,detailChecked:false}, {title:'不明BOX <img src=x onerror=alert(1)>'}]);
  const container={},count={},reviewPanel={},reviewSummary={},reviewContainer={};
  renderRows(container,count,input,{view:'grouped',reviewPanel,reviewSummary,reviewContainer});
  assert.match(container.innerHTML,/在庫あり最安 5,808円/);
  assert.match(container.innerHTML,/表示中の最安 4,000円/);
  assert.match(container.innerHTML,/商品ページ ↗/);
  assert.doesNotMatch(container.innerHTML,/<img/);
  assert.doesNotMatch(container.innerHTML,/product\/2/);
  assert.match(reviewContainer.innerHTML,/product\/2/);
  assert.match(count.textContent,/1商品に集約・個別1件/);
  renderRows(container,count,input,{view:'list'});
  assert.doesNotMatch(container.innerHTML,/groupHeader/);
  assert.match(count.textContent,/3件表示/);
});
