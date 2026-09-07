# 定価台帳の更新履歴

## 2026-09-08 / v0.4.2：旧弾12商品を追加

日本語版の通常1BOX・税込価格。送料は含まない。公式BOX価格がある場合は直接採用し、パック価格から計算した場合は入数の確認元も記録する。通販の再販発送日は、商品の初回発売日に流用しない。

| タイトル | 商品 | BOX基準 | 価格・仕様の根拠 |
|---|---|---:|---|
| ポケカ | M1L メガブレイブ | 5,400円 | [公式商品情報](https://www.pokemon-card.com/ex/m1/index.html)・[公式BOX](https://www.pokemoncenter-online.com/9900000006211.html) |
| ポケカ | M1S メガシンフォニア | 5,400円 | [公式180円/パック](https://www.pokemon-card.com/ex/m1/index.html) × [公式30パック/BOX](https://www.pokemoncenter-online.com/9900000006228.html) |
| ポケカ | M2 インフェルノX | 5,400円 | [公式商品情報](https://www.pokemon-card.com/ex/m2/index.html)・[公式BOX](https://www.pokemoncenter-online.com/9900000006679.html) |
| ポケカ | SV9 バトルパートナーズ | 5,400円 | [公式180円/パック](https://www.pokemon-card.com/ex/sv9/index.html) × [メーカー商品情報30パック/BOX](https://www.amazon.co.jp/dp/B0DB7C1Z26) |
| ポケカ | SV9a 熱風のアリーナ | 5,400円 | [公式商品情報](https://www.pokemon-card.com/products/sv/sv9a.html)・[公式BOX](https://www.pokemoncenter-online.com/9900000006013.html) |
| ポケカ | SV10 ロケット団の栄光 | 5,400円 | [公式商品情報](https://www.pokemon-card.com/ex/sv10/index.html)・[公式BOX](https://www.pokemoncenter-online.com/9900000006037.html) |
| ワンピース | OP-11 神速の拳 | 5,280円 | [公式商品情報](https://www.onepiece-cardgame.com/products/boosters/op11.php)・[公式BOX](https://p-bandai.jp/item/item-1000237262/) |
| ワンピース | OP-12 師弟の絆 | 5,280円 | [公式商品情報](https://www.onepiece-cardgame.com/products/boosters/op12.php)・[公式BOX](https://p-bandai.jp/item/item-1000238054/) |
| ワンピース | OP-13 受け継がれる意志 | 5,280円 | [公式商品情報](https://www.onepiece-cardgame.com/products/boosters/op13/)・[公式BOX](https://p-bandai.jp/item/item-1000243979/) |
| ワンピース | OP-14 蒼海の七傑 | 5,280円 | [公式商品情報](https://www.onepiece-cardgame.com/products/boosters/op14.php)・[公式BOX](https://p-bandai.jp/item/item-1000254607/) |
| DBフュージョンワールド | SB01 MANGA BOOSTER 01 | 7,920円 | [公式330円/パック](https://www.dbs-cardgame.com/fw/jp/products/01_190.html) × [東映アニメーション公式通販24パック/BOX](https://store.toei-anim.co.jp/shop/g/gDBS00120O1/) |
| DBフュージョンワールド | SB02 MANGA BOOSTER 02 | 7,920円 | [公式商品情報](https://www.dbs-cardgame.com/fw/jp/products/01_259.html)・[公式BOX](https://p-bandai.jp/item/item-1000244821/) |

Amazonはメーカー商品情報の入数だけを参照し、販売者の提示価格を定価として採用していない。過去の30商品は今回再確認しておらず、個別の確認日は2026-09-07のまま保持する。

## 通常BOXとの混同を防止

バトルパートナーズのデッキビルドBOX、メガブレイブ／メガシンフォニアのポケモンセンターセット、ロケット団の栄光のアタッシュケースセット等は、同じ弾名でも通常BOXとは仕様が異なる。通常BOXの比較には使わず、初期のBOX表示からも除く。これらの特別セット自体の定価登録は今回の対象外。

- [バトルパートナーズ公式（拡張パックとデッキビルドBOXの別仕様）](https://www.pokemon-card.com/ex/sv9/index.html)
- [メガシンフォニア ポケモンセンターセット](https://www.pokemoncenter-online.com/4521329431710.html)
- [ロケット団の栄光 アタッシュケースセット](https://www.pokemon-card.com/info/004901.html)

検証：39件の自動テストに合格。全登録商品の識別・出典・価格計算、M1L/M1S・SV9/SV9a・M2/M2a・SB01/SB02の区別、特別セットの除外、通常BOXを残すことを確認。Workersデプロイのdry-runにも成功。店舗ごとの実在庫・抽出精度の全面検証は次段階Bで扱う。
