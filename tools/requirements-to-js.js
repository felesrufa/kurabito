/* docs/requirements.initial.json → requirements-default.js
 * アプリは外部から何も読み込めない(CSP の connect-src 'none')ので、必要リストの初期データをスクリプトに埋め込む。
 * 使い方: node tools/requirements-to-js.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'requirements.initial.json'), 'utf8'));
if (data.kind !== 'requirements' || !Array.isArray(data.requirements)) throw new Error('requirements の形ではありません');
const rows = data.requirements.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
const out = `/* 必要リストの初期データ。docs/requirements.initial.json から作る(手で直さない)。
 * 作り直し: node tools/requirements-to-js.js
 */
window.KURABITO_DEFAULT_REQUIREMENTS = {
  schema: ${JSON.stringify(data.schema)},
  kind: 'requirements',
  requirements: [
${rows},
  ],
};
`;
fs.writeFileSync(path.join(root, 'requirements-default.js'), out);
console.log(`requirements-default.js: ${data.requirements.length}件`);
