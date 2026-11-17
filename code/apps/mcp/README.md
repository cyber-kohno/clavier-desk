# ClavierDesk MCP

ローカルのエージェント向けstdio MCPサーバー。Scorehackの接続実装を基にしています。アプリとは別のプロセスで起動し、GUIの起動・停止にかかわらずツール一覧は固定です。

接続基盤については[MCP開発の引継ぎ資料](../../../docs/plan/mcp/handoff.md)、現在の編集・排他仕様については[チェックアウトとUI入力](../../../docs/plan/mcp/checkout-and-ui.md)を参照してください。

空からの構築に加え、既存曲への追加・修正と、装飾音符・トリル・ペダル等の専門編集に対応しています。現行仕様は[継続的な譜面編集](../../../docs/plan/mcp/score-editing-api.md)、表現範囲は[対応表](../../../docs/plan/mcp/notation-capabilities.md)を参照してください。14ツールと28種類の編集操作があります。

## 自動運指

既存ダイアログと同じWorker・自動運指エンジンを使用します。計算候補はエンジン内で既存のモーション検証を通過したものです。MCPから別途アニメーション生成・検証は行いません。

1. `begin_checkout`で取得した`checkoutId`と`revision`を使用します。
2. `request_auto_fingering(sessionId, checkoutId, expectedRevision, requestId, staff, noteIds)`で計算を開始します。`noteIds`は読み取った既存IDで、同じ段・声部の連続した開始範囲です。同じ手の重なる別声部・通常タイ列を自動追加し、追加後も最大256ノートです。返されたincludedNoteIds・addedNotes・voiceCountで実際の対象を確認できます。既存の指は固定されます。同一リクエストの再送では全引数を保持します。
3. `get_auto_fingering_result(sessionId, checkoutId, jobId)`で進捗・結果を取得します。`ready`なら候補の指番号・評価・警告、`failed`なら理由を確認します。失敗時は適用できません。
4. `apply_auto_fingering(sessionId, checkoutId, jobId, expectedRevision)`で候補を作業用譜面に適用します。計算開始後に版が変わると拒否します。同じjobの適用再送は元の結果を返します。
5. `finish_checkout`でまとめて反映し、1回のUndoで戻せます。`cancel_checkout`、公開停止・強制停止では計算と候補を破棄します。

同時計算は1つ、1チェックアウト最大16計算です。トリル・アルペジオ・保持中の指替えなどの既存Auto Assignの制限はそのまま結果に表示します。同じ手の追加対象をまとめて候補算出・検証・適用します。対象範囲の外や反対の手も含む全曲のアニメーション生成成功を保証するものではありません。

更新後はエディターの再読込／再起動とMCPプロセスの再接続が必要です。既存の公開セッションで新しいツールが直ちに使えることを意味しません。

## ビルドと登録

このディレクトリで実行します。

```powershell
node --experimental-transform-types generate-contract.mjs
cargo test
cargo build --release
```

エージェントのローカルstdio MCP設定に、生成された実行ファイルの絶対パスを登録します。Windowsでは`target/release/clavierdesk-mcp.exe`です。引数は不要です。stdoutはMCPのJSON-RPC専用です。

## GUIから公開する

1. ClavierDeskのデスクトップ版を起動します。起動時は非公開です。
2. Ctrl＋Mを押します。WebViewまでの疎通確認後、ヘッダーに`MCP ON`と完全なセッションID（UUID）が表示されます。IDは文字選択してコピーできます。
3. エージェントから`list_clavierdesk_sessions`を呼び、画面のIDと一致するセッションを選びます。
4. その完全なIDを`probe_session`へ渡します。`gui: { application: "ClavierDesk", status: "ok" }`が返れば、stdio→Rustブリッジ→WebView→応答の経路が通っています。
5. Ctrl＋Mを再度押すと`MCP OFF`になり、一覧から消え、そのIDへの要求も失敗します。

複数のClavierDeskを起動し、それぞれ公開できます。自動で対象を一つ選ぶことはなく、`probe_session`には毎回`sessionId`が必要です。公開し直すと新しいIDになります。アプリ終了時は接続と記述子を破棄します。異常終了で記述子が残っても、生存確認に失敗するため一覧へ出ません。

ブラウザー版は公開対象外です。公開失敗時は`MCP ERROR`を表示し、詳細はホバーで確認できます。Ctrl＋Mで再試行できます。

## ツール

| 名前 | 用途 |
| --- | --- |
| `ping` | MCPサーバー単体の疎通。GUI不要。 |
| `list_clavierdesk_sessions` | 公開中かつ認証付き生存確認に成功したセッションのID・PID・公開開始時刻。 |
| `probe_session(sessionId)` | 指定セッションのWebViewまで疎通確認。 |
| `get_capabilities(sessionId, operation?)` | 操作一覧と制限。operationを指定するとその引数スキーマ。チェックアウト不要。 |
| `get_score_overview(sessionId, checkoutId?)` | 小節番号とID・セクション・設定・revision。UIロックなしで実データを取得。 |
| `get_score_range(sessionId, …)` | 既定4・最大8小節、段・声部で絞り込み。checkoutIdを付けると作業用データ。 |
| `begin_checkout(sessionId)` | 編集権取得とUIロック。checkoutIdとrevisionを返す。 |
| `get_editor_state(sessionId, checkoutId)` | 作業用の譜面・カーソル・選択・未保存状態を取得。 |
| `apply_edit(sessionId, checkoutId, …)` | requestId・expectedRevision・operationsで専門編集を原子的に蓄積。旧単一set_pitch_fingering形式も互換維持。 |
| `finish_checkout(sessionId, checkoutId)` | 全編集を一度だけ実プロジェクト・Undo履歴に反映し、所有権とUIロックを解除。その後で完了通知。 |
| `cancel_checkout(sessionId, checkoutId)` | 作業用データを破棄し、UIロック解除。Undo履歴を追加しない。 |

入力の下書き、メニュー、ダイアログ、ファイル操作、再生がある間は`EDITOR_BUSY`でチェックアウトを拒否します。下書きを自動確定・破棄しません。

チェックアウト中は、画面の`Stop MCP editing`ボタンまたはCtrl＋Shift＋Mで強制停止できます。未反映の編集を破棄し、UIロックを解除してから通知します。以前の`checkoutId`は無効になり、同じエージェントが再チェックアウトしても遅延要求を拒否します。反映後の変更はUndoで戻します。

編集ツールのchangedは作業用データの変更です。実プロジェクトへの反映はfinish_checkoutで行い、自動保存はしません。新しい操作配列要求は、begin_checkoutまたはチェックアウトの読み取りで得たrevisionをexpectedRevisionに渡します。成功応答のrevisionを次の要求に使います。同じrequestId・expectedRevision・operationsの再送は元の結果を返し、重複適用しません。

finish_checkout後に再取得し、新しいチェックアウトで追加・修正できます。参照が切れる修正は黙って表現を削除せず、明示的な解除・端点変更を要求します。GUIとMCPを同じソースからビルドし、スキーマ変更後はMCPクライアントを再接続してください。画像の判読はエージェントの責務です。

操作契約はGUIの`score-edit-contract.ts`にまとめています。変更時にはgenerate-contract.mjsでRust向けスキーマを再生成します。テストで生成物の一致を確認します。

トリルの指番号列は`set_trill`の`settings.fingerings`で指定します。例：7音なら`"attackCount": 7, "fingerings": [2, 3, 2, 3, 2, 3, 2]`です。配列は実際の発音順で、各値は1～5、長さはattackCountと一致させます。指替えは使えません。fingeringsを省略すると未設定になります。トリル設定時はタイ列の通常の指番号・指替えを解除します。トリルの本体音符にはset_fingeringや旧set_pitch_fingeringを使わず、set_trillで列を編集してください。

## 接続方式

```text
Agent ↔ stdio ↔ clavierdesk-mcp
  ↔ authenticated loopback HTTP ↔ Tauri
  ↔ clavierdesk://mcp/request / mcp_respond ↔ main WebView
```

Tauriは動的なIPv4ループバックポートを確保し、アプリのローカルデータ領域の`mcp/sessions/<sessionId>.json`へ接続記述子を置きます。アプリIDは`com.clavierdesk.editor`です。Windowsでは`%LOCALAPPDATA%/com.clavierdesk.editor/mcp/sessions`を使います。

記述子の認証トークンはローカル接続専用で、ツールの応答に含めません。MCPサーバーは記述子の形式・接続先・認証付き`/health`のIDを検証します。`POST /bridge`は要求をメインWebViewへ転送し、5秒でタイムアウトします。

## stdioを直接検証する

GUIを公開した状態で、このディレクトリから実行します。Node.js 24系が必要です。

```powershell
node smoke.mjs
# 対象セッションが存在することも確認する場合:
node smoke.mjs ./target/release/clavierdesk-mcp.exe <sessionId>
# 公開解除したIDが一覧から消え、接続も拒否されることを確認する場合:
node smoke.mjs ./target/release/clavierdesk-mcp.exe --absent <previousSessionId>
```

MCP初期化、ツール一覧、セッション一覧、公開中の各WebViewへの疎通、不正なIDの拒否を確認します。公開セッションが0件でも、MCPサーバー単体の検証は成功します。


装飾音の自動運指対応（2026-11-18）: 選択した主音に付属する装飾音を含め、共通の再生計画の発音順・演奏時間で一続きに計算し、同じモーション検証を行います。指定済みの装飾音の指も固定します。未指定件数・結果一覧には装飾音を含みます。MCP候補の装飾音は親のnoteIdとgraceNoteIdで識別し、主音とまとめて原子的に適用します。アルペジオ・トリル・保持中の指替えは引き続き未対応です。
