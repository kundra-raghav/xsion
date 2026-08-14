import { useState } from 'react';
import { clsx } from 'clsx';
import { Label, PrimaryBtn, Input } from '../kit';
import type { Project } from '../Workspace';

const PRINCIPLES = [
  { n: '01', title: 'Bounded, not exhaustive', body: 'Highest-value flows first, breadth-limited, resumable. "Complete map" means the reachable high-value surface, said honestly.' },
  { n: '02', title: 'Verdicts fail safe', body: 'Where Xsion cannot establish an oracle it returns inconclusive. Inconclusive is never reported as pass.' },
  { n: '03', title: "You watch Xsion's render", body: 'The browser runs headless, so the viewport is a screenshot stream of the page, not a live frame of your site.' },
];

const DEFAULT_REPO = '/Users/raghavkundra/Desktop/Dev/dent/apps/admin-ui';

export function OnboardScreen({ project, oracle, setOracle, onBegin }: { project: Project; oracle: 'code' | 'url'; setOracle: (o: 'code' | 'url') => void; onBegin: (cfg: { url: string; repo?: string }) => void }) {
  const [url, setUrl] = useState(project.baseUrl);
  const hasCode = oracle === 'code';              // A2: single source of truth — the topbar ORACLE toggle
  const setHasCode = (v: boolean) => setOracle(v ? 'code' : 'url');
  const [repo, setRepo] = useState(DEFAULT_REPO);

  return (
    <div className="flex h-full overflow-hidden">
      {/* editorial hero */}
      <div className="flex flex-1 flex-col overflow-y-auto p-12">
        <div className="my-auto max-w-[520px]">
          <Label accent className="mb-[22px] tracking-[0.2em]">Onboard</Label>
          <h1 className="m-0 mb-[18px] text-[40px] font-medium leading-[1.06] tracking-tight2 text-balance">Give Xsion a URL.<br />Watch it map the app.</h1>
          <p className="m-0 mb-[34px] max-w-[440px] text-[14.5px] leading-[1.6] text-muted text-pretty">
            The crawl is bounded, resumable, and never blocks on you except once, for credentials. You correct the map afterwards. Then it becomes a project you can point tests at.
          </p>
          <div className="flex flex-col">
            {PRINCIPLES.map((p, i) => (
              <div key={p.n} className={clsx('flex gap-4 border-t border-line py-3.5', i === PRINCIPLES.length - 1 && 'border-b')}>
                <span className="mono w-[18px] pt-0.5 text-[10px] text-muted-2">{p.n}</span>
                <div>
                  <div className="mb-[3px] text-[13px] font-medium">{p.title}</div>
                  <div className="text-[12.5px] leading-[1.5] text-muted-2 text-pretty">{p.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* TARGET panel */}
      <div className="w-[432px] flex-none overflow-y-auto border-l border-line bg-surface p-8">
        <Label className="mb-[18px]">Target</Label>

        <label className="mb-2 block text-[11.5px] font-medium text-muted">Web URL</label>
        <Input value={url} onChange={setUrl} placeholder="https://" mono />

        <div className="mb-2 mt-[26px] text-[11.5px] font-medium text-muted">Do you have the codebase locally?</div>
        <div className="flex flex-col gap-1.5">
          <ModeRow selected={hasCode} onClick={() => setHasCode(true)} label="Yes — point Xsion at the repo" mode="MODE 1" modeColor="text-accent" />
          <ModeRow selected={!hasCode} onClick={() => setHasCode(false)} label="No — URL only" mode="MODE 2" modeColor="text-amber" />
        </div>

        {hasCode && (
          <div className="mt-3.5">
            <label className="mb-2 block text-[11.5px] font-medium text-muted">Repository path</label>
            <Input value={repo} onChange={setRepo} mono />
          </div>
        )}

        <div className={clsx('mt-[22px] rounded-[6px] border p-3.5', hasCode ? 'border-accent-line/40 bg-accent-soft' : 'border-line bg-surface-2')}>
          <Label className={clsx('mb-2', hasCode ? '' : 'text-amber')}>Oracle = {hasCode ? 'the code' : 'observed behavior'}</Label>
          <div className="text-[12.5px] leading-[1.6] text-muted text-pretty">
            {hasCode
              ? 'Xsion reads your source to know what each flow SHOULD do — verdicts are fact-checkable and cite the code line that proves them.'
              : 'No code to check against, so Xsion judges from what it observes plus convention. Verdicts stay weaker and lean on inconclusive — honestly.'}
          </div>
        </div>

        <PrimaryBtn full className="mt-[22px]" onClick={() => onBegin({ url, repo: hasCode ? repo : undefined })}>Begin bounded crawl</PrimaryBtn>
        <div className="mono mt-[11px] text-[9.5px] leading-[1.6] text-muted-2">Nothing is written to your repo. Credentials are asked for once, encrypted at rest, revocable.</div>
      </div>
    </div>
  );
}

function ModeRow({ selected, onClick, label, mode, modeColor }: { selected: boolean; onClick: () => void; label: string; mode: string; modeColor: string }) {
  return (
    <button onClick={onClick}
      className={clsx('flex items-center gap-3 rounded-[5px] border px-3.5 py-3 text-left transition-colors',
        selected ? 'border-accent-line bg-accent-soft' : 'border-line hover:border-line-strong')}>
      <span className={clsx('flex h-3.5 w-3.5 items-center justify-center rounded-full border', selected ? 'border-accent' : 'border-muted-2')}>
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex-1 text-[12.5px] text-ink">{label}</span>
      <span className={clsx('mono text-[9.5px] tracking-[0.1em]', modeColor)}>{mode}</span>
    </button>
  );
}
