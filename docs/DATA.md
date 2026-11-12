# kurabito データ設計

データはすべて端末の中(ブラウザの localStorage)に、1つのJSONとして保存する。
サーバーには何も送らない。書き出し/読み込みも同じJSONを使う。

後から足す機能(必要リスト・条件フィルタ・人数計算・Tips・採点)も、
最初からこの形に入るように場所だけ用意してある。第1版で使うのは ★ の付いた部分。

```jsonc
{
  "app": "kurabito",
  "schemaVersion": 1,
  "exportedAt": "2026-11-12T13:30:00+09:00",   // 書き出し時のみ

  // ★ 設定
  "settings": {
    "leadDays": 30,          // 期限の何日前から「対応待ち」に出すか(品目ごとに上書き可)
    "planDays": 7            // 何日分を備えるか(必要数の計算に使う。v2〜)
  },

  // ★ 持ち物(在庫)
  "items": [
    {
      "id": "i_xxxxxxxx",
      "name": "保存水 2L",
      "genre": "food",             // food / bousai / daily / other
      "quantity": 6,
      "unit": "本",
      "minQuantity": 6,            // これを下回ったら「対応待ち」(null = 見ない)
      "bestBefore": "2028-03-01",  // 賞味期限(null可)
      "useBy": null,               // 使用期限(電池・薬・消火器など。null可)
      "reviewAt": null,            // 見直し日(おむつのサイズ確認など。null可)
      "leadDays": null,            // この品だけの「何日前から」。null = settings を使う
      "location": "",              // 置き場所
      "maker": "", "model": "",    // メーカー・型番(採点用)
      "size": "",                  // サイズ(おむつ等)
      "memo": "",
      "tags": [],                  // v2: 条件フィルタ用のタグ
      "createdAt": "...", "updatedAt": "..."
    }
  ],

  // ★ 対応待ちの状態(スヌーズ)
  // キーは「どの品の・どの知らせか・どの日付/状態に対してか」。
  // 期限の日付が変わればキーも変わるので、また出てくる。
  "alerts": {
    "i_xxxxxxxx|bestBefore|2028-03-01": { "snoozeUntil": "2026-11-15" },
    "i_yyyyyyyy|useBy|2027-01-01":      { "doneAt": "2026-11-12" }
  },

  // v2: 家族(人数計算用)。名前は入れない(「大人1」「子」程度)
  "people": [
    { "id": "p_xxxx", "label": "大人1", "kind": "adult" }  // adult / child / infant / elder
  ],

  // v2: 必要リスト
  "requirements": [
    {
      "id": "r_xxxx",
      "name": "飲料水",
      "unit": "L",
      "match": { "names": ["水"], "itemIds": [] },      // どの持ち物と突き合わせるか
      "formula": {
        "type": "perPersonPerDay",   // perPersonPerDay / perPerson / fixed
        "amount": 3,
        "personKinds": []            // 空 = 全員。["infant"] ならおむつ等
      },
      "override": null,              // 手で決めた数(計算より優先)
      "conditions": {                // 空配列 = すべての条件で必要
        "place":  [],                // home / shelter / camp
        "season": [],                // summer / winter
        "hazard": []                 // quake / typhoon / tsunami / eruption
      },
      "origin": "public",            // public(公的資料) / experience(体験談) / mine(自分メモ)
      "sources": [{ "title": "", "url": "" }]
    }
  ],

  // v3: Tips
  "tips": [
    {
      "id": "t_xxxx",
      "text": "",
      "status": "verified",          // verified(公的資料で確認) / experience(体験談) / mine(自分メモ)
      "related": { "names": [], "genres": [] },
      "sources": [{ "title": "", "url": "" }]
    }
  ],

  // v4: 採点(会話のClaudeが作ったファイルを取り込む。自動でも同じ形)
  "scores": [
    {
      "maker": "", "model": "",
      "category": "簡易トイレ",
      "criteria": [
        { "name": "固まる量", "score": 4, "max": 5, "basis": "", "sources": [] }
      ],
      "unknown": ["耐荷重"],          // 裏が取れなかった項目(点を付けない)
      "scoredAt": "2026-11-12",
      "scoredBy": "claude-chat"       // claude-chat / auto
    }
  ]
}
```

## 「対応待ち」に出る条件(第1版)

| 種類 | 出る条件 | 消える条件 |
|---|---|---|
| 期限(賞味・使用) | 期限まで `leadDays` 日以内、または期限切れ | 日付を更新する / 「このままでいい」を押す / スヌーズ中 |
| 在庫不足 | `quantity < minQuantity` | 数を更新する / スヌーズ中 |
| 見直し日 | `reviewAt` が今日以前 | 見直し日を更新する / 「確認した」を押す / スヌーズ中 |

スヌーズは「明日」「3日後」「1週間後」。期間が過ぎるとまた出てくる。

## 公開リポジトリに入れないもの

- 書き出したバックアップ(`kurabito-backup-*.json`)… `.gitignore` 済み
- 家の事情がわかる初期値・テストデータ
