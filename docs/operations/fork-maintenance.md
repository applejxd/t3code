# fork の保守（applejxd/t3code）

`applejxd/t3code` は `pingdotgg/t3code` の fork で、`stable` が本線です。upstream のリリースタグを
`stable` に取り込み続けるため、独自パッチの**意図**と取り込み手順をこのページに残します。fork 専用の
ページなので、upstream の merge で衝突しません。

## 独自パッチ

取り込みで衝突したら、まず意図で判断します。upstream が同じ意図の変更を入れていれば upstream を優先し、
fork の重複を消します。意図が反映されていなければ、新しい upstream のコードに同じ意図の修正をします。
コミットは `git show <ハッシュ>` で読めます。

### 1. Pi の `bg_run` ジョブを生かす（`d4b23ffc`）

- 意図: Pi は終了時に pi-background のジョブ（`bg_run`）を殺します。upstream のままだと、Pi アダプタが
  「保留中の作業なし」と答え、ターン終了の 30 分後にアイドル release がセッションごとジョブを止めます。
  RPC の出力から `bg_run` の開始と終了を追跡し、保留中の作業として報告します。スレッドには
  background_task として出し、自動 settle を止めます。
- 場所: `packages/provider-pi/src/server/adapter.ts`（`backgroundJobs`、`hasPendingBackgroundWork`、
  `hasPendingBackgroundWorkForThread`）。テストは `adapter.test.ts`、利用者向けの説明は
  `docs/user/providers-pi.md` の Background Jobs。
- 取り込み時: upstream は v0.1.11（#38582）で同じ `backgroundTasksEndWithProcess: true` を足しました。
  宣言は upstream の 1 つにまとめ、`hasPendingBackgroundWork` の `|| backgroundJobs.size > 0` は残します。

### 2. Pi のアイドル pin を最大 7 日にする（`a82f2317`）

- 意図: manager は、無音のバックグラウンド作業を 4 時間で release します（全 provider 共通）。学習ジョブの
  ように無音で長く走る作業が、連休で止まります。session runtime が `maxIdlePinMs` を宣言できるようにし、
  Pi は 7 日を宣言します。ほかの provider は 4 時間のままです。
- 場所: `packages/provider-core/src/server/ProviderAdapter.ts`、
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts`、`adapter.ts` の `PI_MAX_IDLE_PIN_MS`。
  テストは `ProviderSessionManager.test.ts`。
- 取り込み時: manager の idle 判定が変わったら、`maxIdlePinMs` を使う分岐が残っているか確認します。

### 3. fork のリリース workflow（`11782a7d`、`5decc2b3`）

- 意図: `release.yml` は pingdotgg/t3code 専用で、Blacksmith ランナー、Cloudflare、署名の資格情報が要ります。
  GitHub ホストのランナーだけで、CLI アーカイブ、Windows CLI zip、`SHA256SUMS`、署名なしの Windows x64
  インストーラを GitHub Release に出します。タグは `v<base>-fork.<n>` です。upstream は `-nightly.` と
  `-preview.` しか付けないので、タグが衝突しません。
- 場所: `.github/workflows/release-fork.yml`。Windows のビルドは `release-desktop.yml` を変更せずに呼びます。
- 取り込み時: `release-desktop.yml` やビルドスクリプトが変わったら、fork の workflow が渡す入力が合っているか
  確認します。

### 4. インストーラと自己更新が fork のリリースを選ぶ（`5decc2b3`、`35756f32`）

- 意図: `install.sh`・`install.ps1`、`t3 update`、モバイルの更新確認、SSH と固定 runtime のアーカイブ取得は、
  pingdotgg/t3code のリリースを固定で読み、バージョンを素の semver で比べます。それだと `x.y.z-fork.n` が
  `x.y.z` より下の prerelease に見えます。リリースリポジトリを applejxd/t3code にし、stable は「fork リリースの
  うち最新（base、次に n が最大）を優先し、無いときだけ素のリリース」を選びます。fork ビルドが同じ base の
  素のリリースへ横滑りしたり、下がったりしません。
- 場所: `packages/shared/src/cliRelease.ts`（`CLI_RELEASE_REPOSITORY`、`compareCliReleaseVersions`）、
  `scripts/install.sh`・`install.ps1`、`apps/server/src/cli/update.ts`、
  `apps/server/src/cloud/serviceProtocol.ts`、`apps/mobile/src/features/settings/environment-maintenance.ts`。
  テストは各ファイルの隣と `scripts/install.test.ts`。
- 取り込み時: upstream 側の関数の引数やリリース取得の変更に追随します。v0.1.11 では次の 3 件がありました。
  - `runUpdate` に必須の `databasePath` が増え、fork のテスト `update.test.ts` が型検査で落ちました。
  - `packages/ssh/src/tunnel.test.ts` は、`CLI_RELEASE_REPOSITORY` が fork を指すので fork の URL を期待します。
  - `environment-maintenance.ts` は衝突しました。upstream の文言の i18n 化と fork の
    `compareCliReleaseVersions` は意図が別なので、両方残しました。

### 5. インストーラは `gh` が使えるとき、リリース一覧を `gh` で取る（`54555e85`、`a7bff4b7`）

- 意図: 匿名の GitHub API は 60 回/時間で、すぐ制限に当たります。`gh` が入っていて、`GH_TOKEN` か
  `GITHUB_TOKEN` があるか `gh auth token --hostname github.com` がトークンを返すとき、`gh api` で一覧を取ります。
  `gh auth status` は別のアカウントの検証失敗でも 1 を返すので使いません。`gh api` が失敗したら匿名に戻します。
- 場所: `scripts/install.sh`・`install.ps1`、`scripts/install.test.ts`。

### 6. README の fork 告知（`910ea5d1`）

- 意図: README の先頭に、fork の説明と fork 用の install コマンドを置きます。それより下は upstream の
  README のままです。
- 取り込み時: 先頭の「Based on upstream」の版を、取り込んだタグに更新します。

### 7. インストーラの Pages 配信

- 意図: README の install コマンドが指す `https://applejxd.github.io/t3code/install.sh`・`install.ps1` を、
  手作業のコピーなしで `stable` と一致させます。`scripts/install.*` を `stable` に push すると、
  `.github/workflows/publish-installers.yml` が Pages に配信します。入口ページは `.github/pages/index.html` です。
- 設定（一度だけ。この順に行います）:
  1. Settings → Pages → Build and deployment → Source を「GitHub Actions」にします。
  2. Settings → Environments → `github-pages` の Deployment branches and tags に `stable` を足します。今は
     `gh-pages` だけが許可されていて、足さないと「Branch "stable" is not allowed to deploy to github-pages」で
     配信が失敗します。`gh api -X POST repos/applejxd/t3code/environments/github-pages/deployment-branch-policies -f name=stable -f type=branch`
     でも足せます。
  3. `stable` を push します（または Actions タブの Run workflow）。

  切り替えから最初の配信が終わるまで、サイトが 404 になりえます。配信を確認できたら、`gh-pages`
  ブランチと、環境の `gh-pages` のルールは削除してかまいません。

- ブランチ経由にしない理由: 公式 docs に「GITHUB_TOKEN を使う workflow が push したコミットは、Pages の
  ビルドを起動しない」とあります
  （[Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)）。

`88731dc3` と `7f289e8e` は、Actions の workflow 索引を促すだけの空コミットです。

## upstream の取り込み手順

定期実行（T3 の scheduled task）は、この手順に従います。束縛したスレッドへ、実行ごとに新しいセッションで投稿されます。
worktree と枝（`t3/merge-upstream-tag-into-stable`）は実行をまたいで使い回すので、枝には `stable` へ未統合の成果
（統合待ち）が残っていることがあります。その扱いは [統合待ちのとき](#統合待ちのとき) にあります。

1. **最新タグ**: `gh api repos/pingdotgg/t3code/releases/latest --jq .tag_name`（nightly と preview は対象外）。
2. **fetch**: clone は浅いです。タグが数十個入るのを避けるため `--no-tags` を付け、前回の基準版（README 先頭の
   「Based on upstream」の版。日付は `git log -1 --format=%cs <旧タグ>`）のコミット日の 2 日前から取ります。

   ```sh
   git fetch --no-tags --shallow-since=<前回の基準版の日付 − 2 日> origin stable
   git fetch --no-tags --shallow-since=<同じ日付> https://github.com/pingdotgg/t3code.git \
     refs/tags/<新>:refs/tags/<新> refs/tags/<旧>:refs/tags/<旧>
   ```

3. **判定**: `git merge-base --is-ancestor <新タグ> <ref>` の終了コードで分けます（0 は祖先、1 は祖先でない、
   それ以外はエラーです。タグの fetch 不足など）。この手順では、枝にも本体にも触れません。
   - `stable` で 0: 取り込み済みです。何もせず、報告して終わります。
   - `stable` で 1、`HEAD` で 0: 前回の統合待ちです。マージをやり直しません。手順 4 で追いつかせ、手順 6 の検証が
     通ることを確かめて、手順 7 の統合だけを行います。
   - どちらも 1: 新しいリリースです。手順 4 から続けます。
4. **枝を stable に追いつかせる**: worktree の枝で `git merge stable` を実行します。ローカルの `stable`（未 push の分を
   含む）に追いつきます。`origin/stable` から切らず、合わせません。`stable` に未統合のコミットがある枝は、
   捨てません（`reset` や作り直しをしません）。衝突したら、手順 5 と同じく上のパッチの意図で判断します。
   本体の checkout には、手順 7 まで触れません。
5. **マージ**: `git merge <新タグ>`。枝に統合待ちがあれば、その上にさらにマージします（`stable` からやり直さず、
   統合は枝ごとにまとめて 1 回です）。衝突は上のパッチの意図で判断します。解決の確認は
   `git show --remerge-diff <マージコミット>` で見られます。続けて README 先頭の「Based on upstream」の版を
   新タグに更新し、同じ枝でコミットします。
6. **検証**: マージコミットの後に `vp run check:changed <新タグ>` を実行します。衝突しない不整合（引数の追加、
   期待 URL など）もここで見つかります。workflow が変わると、全パッケージの型検査などが対象になります。全テスト、
   build、release smoke は CI が実行するので、出力の最後の「CI also runs」を見てください。
7. **統合**:
   - 本体に触れずに確かめます。`git worktree list` で本体が `[stable]` であること、
     `git merge-tree --write-tree stable <枝>` が 0 で終わること（衝突があれば統合せず、報告して止まります）。
   - 本体の checkout に触れるコマンドは、統合の 1 回だけにします:
     `git -C <本体の checkout> merge --no-ff -m "Merge branch '<枝>' into stable" <枝>`。承認が出て答えが無ければ、
     繰り返さず止まります。報告は [報告の先頭](#報告の先頭) の形で書きます。
   - push は手動です（`git push origin stable`）。
8. **統合の後（利用者の操作）**: 定期実行は、ここから先を実行しません。本体に触れるのは手順 7 の 1 回だけで、
   push もしません。必要なものは、報告の最後で案内します。
   - 本体で `vp i` を実行します。
   - `scripts/install.*` が変わっていれば、`git push origin stable` で `publish-installers.yml` が Pages に配信します。
   - リリースするときは `v<base>-fork.<n>` のタグを push します（`release-fork.yml` が走ります）。

   枝は、統合のマージコミット分だけ `stable` より古くなります。次の実行が手順 4 で追いつかせます。

### 報告の先頭

最初の行に状態を書きます。統合していないとき（承認待ち、前回の統合待ちを統合できなかったとき）は、次の行に、
そのまま実行できる統合コマンドの全文（`<本体の checkout>` と `<枝>` を実際の値に置き換えたもの）を書きます。

- 取り込み済み: `取り込み済み` で始まる 1 行で終わります（未 push の件数などは、同じ行に添えます）。
- 新しいリリースを統合できた: `統合済み`。続けて変更の要点と検証の結果を書きます。
- 新しいリリースを統合できなかった（承認に答えが無かった）: `承認待ち`。次の行に統合コマンドを書きます。
- 前回の統合待ちを見つけた: `統合待ち（<マージコミットの日付> から）`。続けて、今回の統合の結果（統合済み、または承認待ちと
  統合コマンド）を書きます。
- `git merge-tree` が 0 以外（衝突）: `統合不可（衝突）`。統合コマンドは書かず、衝突したファイルを書きます。

### 統合待ちのとき

承認が間に合わなかった実行は、worktree の枝にコミットを残して止まります。`stable` も `origin/stable` も動きません。
タスクの表示は、run が失敗・中断・キャンセルで終わったときだけ「失敗」になります（サーバーが run の終了を待って更新します）。
承認待ちを報告して正常に終わった run は「成功」のままなので、状態は報告の最初の行で見ます。

- 次の実行は、手順 3 で統合待ちと判定し、統合だけを行います。新しいリリースが来ていれば、枝の上に
  さらにマージして、まとめて統合します。
- 自分で統合するには、報告にある統合コマンドを、自分の端末で実行します（Pi の承認は要りません）。
  その後に push します。
- 枝と、束縛したスレッドは、統合が済むまで削除しません。スレッドを削除するとタスクも消えます。

### toolchain と既知の失敗

- `packageManager` は `pnpm@12.14.0`、`engines.node` は `26.13.1` です。無い機では、`pnpm` を作業ツリー直下の
  `.tmp/` に入れ、`pnpm install --frozen-lockfile --ignore-scripts` で `node_modules/.bin/vp` を得ます。
  `prepare`（`vp config --no-agent`）は git hooks の dispatcher を入れ、設定を clone 単位で記録します。
  worktree から実行すると本体の clone にも影響しうるので、`--ignore-scripts` を付けます。
- `packages/ssh/src/tunnel.test.ts` の次の 2 件は、テストの子プロセスが `sh` の既定 PATH しか持たないので、
  node を `/usr/bin` の外（mise など）に入れた機では `exec: node: not found` で落ちます。マージとは無関係です。
  - `archive launch script > a reconnect from an older client keeps a newer managed server running`
  - `archive launch script > a newer client still replaces an older managed server`
