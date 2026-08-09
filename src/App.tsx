import { useEffect, useMemo, useRef, useState } from 'react'
import Viewer from './Viewer'
import type { ConnectorPosition, GeneratedFile, MeshSummary, WorkerRequest, WorkerResponse } from './types'

const formatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })

export default function App() {
  const worker = useRef<Worker | null>(null)
  const [mesh, setMesh] = useState<MeshSummary | null>(null)
  const [blockCount, setBlockCount] = useState(3)
  const [objectScale, setObjectScale] = useState(1)
  const [pinDiameter, setPinDiameter] = useState(6)
  const [pinPitch, setPinPitch] = useState(16)
  const [status, setStatus] = useState('STL 파일을 선택하면 브라우저 안에서 분석합니다.')
  const [error, setError] = useState('')
  const [files, setFiles] = useState<GeneratedFile[]>([])
  const [connectors, setConnectors] = useState<ConnectorPosition[][]>([])
  const [busy, setBusy] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [viewerVersion, setViewerVersion] = useState(0)

  useEffect(() => {
    const instance = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'PROGRESS') setStatus(event.data.message)
      if (event.data.type === 'ERROR') setBusy(false)
      if (event.data.type === 'ERROR') { setError(event.data.message); setStatus('파일을 다시 선택해 주세요.') }
      if (event.data.type === 'STL_LOADED') {
        setMesh(event.data.mesh)
        setError('')
        setBusy(false)
        setStatus(`${event.data.mesh.triangles.toLocaleString()} triangles ready — preview updates instantly.`)
      }
      if (event.data.type === 'GENERATION_COMPLETE') {
        setFiles(event.data.files)
        setConnectors(event.data.connectors)
        setBusy(false)
        setStatus(`${event.data.files.length} watertight STL blocks are ready to download.`)
      }
    }
    worker.current = instance
    return () => instance.terminate()
  }, [])

  useEffect(() => {
    const saved = window.localStorage.getItem('blockstl-settings')
    if (!saved) return
    try {
      const settings = JSON.parse(saved) as Record<string, number>
      if (settings.blockCount) setBlockCount(settings.blockCount)
      if (settings.objectScale) setObjectScale(settings.objectScale)
      if (settings.pinDiameter) setPinDiameter(settings.pinDiameter)
      if (settings.pinPitch) setPinPitch(settings.pinPitch)
    } catch { window.localStorage.removeItem('blockstl-settings') }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('blockstl-settings', JSON.stringify({ blockCount, objectScale, pinDiameter, pinPitch }))
  }, [blockCount, objectScale, pinDiameter, pinPitch])

  const cuts = useMemo(() => {
    if (!mesh) return []
    const [minZ, maxZ] = [mesh.bounds.min[2], mesh.bounds.max[2]]
    return Array.from({ length: blockCount - 1 }, (_, index) => minZ + ((index + 1) * (maxZ - minZ)) / blockCount)
  }, [blockCount, mesh])

  const scaledBounds = useMemo(() => mesh ? [
    (mesh.bounds.max[0] - mesh.bounds.min[0]) * objectScale,
    (mesh.bounds.max[1] - mesh.bounds.min[1]) * objectScale,
    (mesh.bounds.max[2] - mesh.bounds.min[2]) * objectScale,
  ] : null, [mesh, objectScale])
  const connectorError = pinPitch < pinDiameter + 1 ? 'Grid pitch must be at least pin diameter + 1 mm.' : ''

  async function openFile(file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.stl')) {
      setError('STL 확장자 파일만 지원합니다.')
      return
    }
    setError('')
    setStatus('파일을 worker로 전달하고 있습니다…')
    const buffer = await file.arrayBuffer()
    worker.current?.postMessage({ type: 'LOAD_STL', buffer, name: file.name } satisfies WorkerRequest, [buffer])
  }

  function loadDemo() {
    const cube = cubeStl()
    const buffer = new TextEncoder().encode(cube).buffer
    setStatus('데모 메시를 준비하고 있습니다…')
    worker.current?.postMessage({ type: 'LOAD_STL', buffer, name: 'demo-cube.stl' } satisfies WorkerRequest, [buffer])
  }

  function generate() {
    if (!mesh || connectorError) return
    setFiles([]); setConnectors([]); setError('')
    setBusy(true)
    worker.current?.postMessage({ type: 'GENERATE_BLOCKS', settings: { blockCount, objectScale, pinDiameter, pinPitch, pinHeight: Math.max(4, pinDiameter * 1.25), socketClearance: 0.25 } } satisfies WorkerRequest)
  }

  function download(file: GeneratedFile) {
    const url = URL.createObjectURL(new Blob([file.buffer], { type: 'model/stl' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 250)
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="BlocksTL home"><span className="brand-mark">B</span><span>BlocksTL</span></a>
        <p>Split STL into interlocking building blocks</p>
        <span className="badge">Browser-only</span>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="section-heading"><span>PROJECT</span><i /></div>
          <label className="file-button">
            <input type="file" accept=".stl,model/stl" onChange={(event) => void openFile(event.target.files?.[0])} />
            <span>Open STL</span><small>Binary & ASCII</small>
          </label>
          <p className="drop-help">Or drop an STL anywhere on the preview.</p>
          <button className="link-button" onClick={loadDemo}>Try a demo cube</button>

          <div className="section-heading"><span>SPLIT PLAN</span><i /></div>
          <label className="field">
            <span>Number of blocks <output>{blockCount}</output></span>
            <input type="range" min="2" max="8" value={blockCount} onChange={(event) => setBlockCount(Number(event.target.value))} />
          </label>
          <label className="field compact">
            <span>Object scale</span>
            <input type="number" min="0.1" max="10" step="0.1" value={objectScale} onChange={(event) => setObjectScale(Number(event.target.value) || 1)} />
          </label>

          <div className="section-heading"><span>CONNECTORS <em>MVP</em></span><i /></div>
          <label className="field compact"><span>Pin diameter <output>{pinDiameter} mm</output></span><input type="number" min="1" max="20" value={pinDiameter} onChange={(event) => setPinDiameter(Number(event.target.value) || 1)} /></label>
          <label className="field compact"><span>Grid pitch <output>{pinPitch} mm</output></span><input type="number" min="2" max="50" value={pinPitch} onChange={(event) => setPinPitch(Number(event.target.value) || 2)} /></label>

          {connectorError && <p className="setting-error">{connectorError}</p>}

          <button className="generate" disabled={!mesh || busy || Boolean(connectorError)} onClick={generate}>{busy ? 'Generating…' : 'Generate blocks'} <span>→</span></button>
          <p className="phase-note">Scale applies to both the preview and generated STL. The model stays in your browser; only selected files are processed.</p>
        </aside>

        <section className={`canvas-area ${dropActive ? 'drop-active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDropActive(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDropActive(false) }} onDrop={(event) => { event.preventDefault(); setDropActive(false); void openFile(event.dataTransfer.files[0]) }}>
          <div className="canvas-topline"><span>{mesh ? mesh.name : 'No model loaded'}</span><span className="hint">drag to orbit · scroll to zoom</span></div>
          {mesh && <button className="view-reset" onClick={() => setViewerVersion((value) => value + 1)}>Reset view</button>}
          {mesh ? <Viewer key={viewerVersion} mesh={mesh} blockCount={blockCount} objectScale={objectScale} connectors={connectors} /> : <EmptyState onDemo={loadDemo} />}
          {mesh && <div className="legend">{Array.from({ length: blockCount }, (_, index) => <span key={index}><b style={{ background: ['#3d7eff', '#9c75ff', '#f46f9d', '#f6a443', '#3bc3a1', '#5db5f2', '#e87bc1'][index] }} />Block {index + 1}</span>)}</div>}
          {files.length > 0 && <div className="downloads"><strong>Generated STL files</strong>{files.map((file) => <button key={file.name} onClick={() => download(file)}>{file.name}<small>{file.triangles.toLocaleString()} triangles</small></button>)}</div>}
        </section>

        <aside className="inspector">
          <div className="section-heading"><span>MODEL INFO</span><i /></div>
          {mesh ? <>
            <dl>
              <div><dt>Triangles</dt><dd>{mesh.triangles.toLocaleString()}</dd></div>
              <div><dt>Output X</dt><dd>{formatter.format(scaledBounds![0])} mm</dd></div>
              <div><dt>Output Y</dt><dd>{formatter.format(scaledBounds![1])} mm</dd></div>
              <div><dt>Output Z</dt><dd>{formatter.format(scaledBounds![2])} mm</dd></div>
            </dl>
            <div className="section-heading cut-heading"><span>CUT POSITIONS</span><i /></div>
            <ol className="cuts">{cuts.map((cut, index) => <li key={cut}><span>Interface {index + 1}</span><strong>Z {formatter.format(cut)}</strong></li>)}</ol>
          </> : <p className="muted">A loaded STL will show triangle count, bounds, and evenly spaced Z cuts here.</p>}
          <div className={`status ${error ? 'error' : ''} ${busy ? 'working' : ''}`}><span className="status-dot" />{error || status}</div>
        </aside>
      </section>
    </main>
  )
}

function EmptyState({ onDemo }: { onDemo: () => void }) {
  return <div className="empty"><div className="empty-cube"><span /><span /><span /></div><h1>Ready for your mesh.</h1><p>Open an STL to inspect it, calculate its bounding box, and preview evenly spaced Z-axis blocks.</p><button onClick={onDemo}>Preview demo cube</button></div>
}

function extent(min: number, max: number) { return `${formatter.format(max - min)} mm` }

function cubeStl() {
  const points = [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `solid cube\n${faces.map((face) => `facet normal 0 0 0\n outer loop\n${face.map((index) => `  vertex ${points[index].join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid cube`
}
