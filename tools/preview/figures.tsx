// Превью всех схем упражнений на одной странице: node tools/preview/render-figures.mjs
import { createRoot } from 'react-dom/client';
import { FIGURES } from '../../src/figures/poses';
import { FigureSVG } from '../../src/figures/ExerciseFigure';
import '../../src/styles.css';

function vb(def: any) { return (window as any).__vb?.(def) ?? '40 0 360 270'; }

function Page() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${(window as any).COLS || 2}, 1fr)`, gap: 12, padding: 12, background: 'var(--bg)' }}>
      {Object.entries(FIGURES).map(([id, def]) => (
        <div key={id} className="figure-box">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{id}</div>
          <div className="figure-frames">
            {[0, 1].map((i) => (
              <div key={i} className="figure-frame"><FigureSVG def={def} pose={def.frames[i]} pedals={def.pedals?.[i]} frameIndex={i as 0 | 1} viewBox={(window as any).vbs[id]} title={id} /></div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
