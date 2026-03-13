# プロジェクト概要
- 言語: TypeScript 5.x
- フレームワーク: Next.js 14 (App Router)
- ORM: Prisma
- DB: PostgreSQL 15
- テスト: Vitest + Testing Library
- リンター: ESLint (flat config) + Prettier
- CI: GitHub Actions
- 認証: NextAuth.js
- ロガー: pino (JSON構造化ログ)

# コーディング規約
- 早期リターンを優先し、ネストは最大3段まで
- any禁止。unknownから型ガードで絞る
- エラーはResult型で返す(repositoryレイヤー以外でtry-catchしない)
- import順序: 外部 → @/ エイリアス → 相対パス、各グループ間に空行
- テストファイルは同ディレクトリに .test.ts で配置
- コミットメッセージ: Conventional Commits

# よく出るレビュー指摘(過去のPRから抽出)
- useEffectの依存配列漏れ
- Prismaのトランザクション未使用(複数write操作時)
- APIレスポンスに内部エラーメッセージが露出
- (ここにチーム固有の指摘パターンを追記していく)