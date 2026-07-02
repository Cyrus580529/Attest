// inferContract 真实页面评估器：对 test/fixtures/real/*.html 跑推断，打质量指标。
// 用法：npx tsx examples/infer-eval.ts
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { inferContract } from '../src/contract/inferContract';

for (const name of ['hn', 'github-login', 'wikipedia']) {
  const html = readFileSync(`test/fixtures/real/${name}.html`, 'utf8');
  const w = new Window({
    settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true },
  });
  w.document.write(html);
  const { snapshot: s } = inferContract(w.document.body as unknown as ParentNode, `/${name}`);
  console.log(`\n===== ${name} =====`);
  console.log(`objects=${s.objects.length} actions=${s.actions.length} controls=${s.controls.length} surfaces=${s.surfaces.length}`);
  const labels = s.actions.map((a) => a.label);
  console.log(`action 重复标签数=${labels.length - new Set(labels).size}`);
  console.log(`超长 label(>120ch)=${[...s.objects, ...s.actions].filter((n) => n.label.length > 120).length}`);
  console.log(`匿名控件(field)=${s.controls.filter((c) => c.name === 'field').length}`);
  console.log('前 8 action:', s.actions.slice(0, 8).map((a) => `${a.name.slice(0, 24)}${a.risk === 'high' ? '(高)' : ''}`).join(' | '));
  console.log('前 6 control:', s.controls.slice(0, 6).map((c) => c.name.slice(0, 24)).join(' | '));
  console.log('object 样例:', s.objects.slice(0, 2).map((o) => o.label.slice(0, 70)));
}
