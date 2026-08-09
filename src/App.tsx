import { useEffect, useMemo, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import Viewer from './Viewer'
import type { ConnectorPosition, GeneratedFile, MeshSummary, WorkerRequest, WorkerResponse } from './types'

const formatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const blockColors = ['#4f8cff', '#9a78ff', '#ef6f9d', '#f1a54b', '#42c5a6', '#58b7ed', '#e079c1', '#b8d75d']

export default function App() {
  const worker = useRef<Worker | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [mesh, setMesh] = useState<MeshSummary | null>(null)
  const [blockCount, setBlockCount] = useState(3)
  const [objectScale, setObjectScale] = useState(1)
  const [pinDiameter, setPinDiameter] = useState(6)
  const [pinPitch, setPinPitch] = useState(16)
  const [springPreload, setSpringPreload] = useState(0.15)
  const [status, setStatus] = useState('STL 파일을 선택해 시작하세요.')
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
      if (event.data.type === 'ERROR') {
        setError(friendlyError(event.data.message))
        setBusy(false)
        setStatus('설정을 확인한 뒤 다시 시도해 주세요.')
      }
      if (event.data.type === 'STL_LOADED') {
        setMesh(event.data.mesh)
        setError('')
        setFiles([])
        setConnectors([])
        setBusy(false)
        setViewerVersion((value) => value + 1)
        setStatus(`모델을 불러왔습니다 · 삼각형 ${event.data.mesh.triangles.toLocaleString()}개`)
      }
      if (event.data.type === 'GENERATION_COMPLETE') {
        setFiles(event.data.files)
        setConnectors(event.data.connectors)
        setBusy(false)
        setStatus(`블록 ${event.data.files.length}개가 준비됐습니다.`)
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
      if (settings.springPreload !== undefined) setSpringPreload(settings.springPreload)
    } catch { window.localStorage.removeItem('blockstl-settings') }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('blockstl-settings', JSON.stringify({ blockCount, objectScale, pinDiameter, pinPitch, springPreload }))
  }, [blockCount, objectScale, pinDiameter, pinPitch, springPreload])

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
  const pinHeight = Math.max(3, pinDiameter * 0.8)
  const springThickness = Math.max(0.75, Math.min(1.2, pinDiameter * 0.14))
  const springCellWidth = pinDiameter - springPreload + springThickness * 2 + 1.2
  const blockLayerHeight = scaledBounds ? scaledBounds[2] / blockCount : Infinity
  const spacingError = pinPitch < springCellWidth + 0.8 ? `현재 결합부에는 핀 간격 ${Math.ceil((springCellWidth + 0.8) * 10) / 10} mm 이상이 필요합니다.` : ''
  const thicknessError = blockLayerHeight < pinHeight + Math.max(1.2, pinDiameter * 0.22) ? '블록 한 층이 결합부보다 얇습니다. 블록 개수나 핀 지름을 줄여 주세요.' : ''
  const connectorError = spacingError || thicknessError
  const connectorTotal = connectors.reduce((total, plan) => total + plan.length, 0)

  async function openFile(file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.stl')) {
      setError('STL 형식의 파일만 열 수 있습니다.')
      return
    }
    setError('')
    setFiles([])
    setConnectors([])
    setStatus('파일을 읽고 있습니다…')
    const buffer = await file.arrayBuffer()
    worker.current?.postMessage({ type: 'LOAD_STL', buffer, name: file.name } satisfies WorkerRequest, [buffer])
  }

  function loadDemo() {
    const buffer = new TextEncoder().encode(cubeStl()).buffer
    setError('')
    setFiles([])
    setConnectors([])
    setStatus('샘플 모델을 준비하고 있습니다…')
    worker.current?.postMessage({ type: 'LOAD_STL', buffer, name: 'sample-cube.stl' } satisfies WorkerRequest, [buffer])
  }

  function generate() {
    if (!mesh || connectorError) return
    setFiles([])
    setConnectors([])
    setError('')
    setBusy(true)
    setStatus('블록 생성을 시작합니다…')
    worker.current?.postMessage({ type: 'GENERATE_BLOCKS', settings: {
      blockCount, objectScale, pinDiameter, pinPitch,
      pinHeight, socketClearance: 0.35, springPreload,
    } } satisfies WorkerRequest)
  }

  function download(file: GeneratedFile) {
    saveBlob(new Blob([file.buffer], { type: 'model/stl' }), file.name)
  }

  function downloadAll() {
    if (!files.length) return
    const archive = zipSync(Object.fromEntries(files.map((file) => [file.name, new Uint8Array(file.buffer)])))
    const baseName = mesh?.name.replace(/\.stl$/i, '') || 'blockstl'
    saveBlob(new Blob([archive as BlobPart], { type: 'application/zip' }), `${baseName}_blocks.zip`)
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="BlocksTL 홈">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>BlocksTL</span>
        </a>
        <p>STL을 조립 가능한 블록으로 나눠보세요</p>
        <span className="privacy-badge"><span aria-hidden="true">●</span> 내 기기에서만 처리</span>
      </header>

      <section className="workspace">
        <aside className="sidebar" aria-label="블록 생성 설정">
          <StepTitle number="1" title="STL 파일" />
          <label className="file-button">
            <input ref={fileInput} type="file" accept=".stl,model/stl" onChange={(event) => void openFile(event.target.files?.[0])} />
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span>STL 파일 선택</span>
            <small>Binary · ASCII, 기기에서 바로 처리</small>
          </label>
          <button className="sample-button" onClick={loadDemo}>샘플 모델로 체험하기 <span>→</span></button>

          <StepTitle number="2" title="분할 설정" />
          <label className="field">
            <span>블록 개수 <output>{blockCount}개</output></span>
            <input aria-label="블록 개수" type="range" min="2" max="8" value={blockCount} onChange={(event) => setBlockCount(Number(event.target.value))} />
            <span className="range-scale"><small>2</small><small>8</small></span>
          </label>
          <label className="field">
            <span>출력 크기 <output>{Math.round(objectScale * 100)}%</output></span>
            <div className="scale-options">
              {[0.5, 1, 1.5, 2].map((scale) => <button key={scale} type="button" className={objectScale === scale ? 'active' : ''} onClick={() => setObjectScale(scale)}>{scale * 100}%</button>)}
            </div>
          </label>

          <StepTitle number="3" title="결합부 설정" />
          <div className="field-row">
            <label className="field compact">
              <span>핀 지름</span>
              <div className="number-input"><input aria-label="핀 지름" type="number" min="1" max="20" step="0.5" value={pinDiameter} onChange={(event) => setPinDiameter(Number(event.target.value) || 1)} /><span>mm</span></div>
            </label>
            <label className="field compact">
              <span>핀 간격</span>
              <div className="number-input"><input aria-label="핀 간격" type="number" min="2" max="50" step="1" value={pinPitch} onChange={(event) => setPinPitch(Number(event.target.value) || 2)} /><span>mm</span></div>
            </label>
          </div>
          <label className="field fit-field">
            <span>결합 강도 <output>{springPreload <= 0.06 ? '부드럽게' : springPreload >= 0.24 ? '단단하게' : '균형'}</output></span>
            <div className="fit-options">
              <button type="button" className={springPreload === 0.05 ? 'active' : ''} onClick={() => setSpringPreload(0.05)}>부드럽게<small>자주 분리</small></button>
              <button type="button" className={springPreload === 0.15 ? 'active' : ''} onClick={() => setSpringPreload(0.15)}>균형<small>PLA 권장</small></button>
              <button type="button" className={springPreload === 0.25 ? 'active' : ''} onClick={() => setSpringPreload(0.25)}>단단하게<small>강한 고정</small></button>
            </div>
          </label>
          <div className="connector-summary"><span>원형 테이퍼 핀</span><span>탄성 스프링 소켓</span><small>핀 높이 {formatter.format(pinHeight)} mm · 셀 폭 {formatter.format(springCellWidth)} mm</small></div>
          {connectorError && <p className="setting-error">{connectorError}</p>}

          <button className="generate" disabled={!mesh || busy || Boolean(connectorError)} onClick={generate}>
            {busy ? <><span className="spinner" /> 블록 생성 중…</> : <>블록 생성하기 <span>→</span></>}
          </button>
          <p className="privacy-note"><span aria-hidden="true">◇</span> 선택한 파일은 서버로 전송되지 않습니다.</p>
        </aside>

        <section className={`canvas-area ${dropActive ? 'drop-active' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDropActive(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDropActive(false) }}
          onDrop={(event) => { event.preventDefault(); setDropActive(false); void openFile(event.dataTransfer.files[0]) }}>
          <div className="canvas-toolbar">
            <div className="model-name"><span className={mesh ? 'ready' : ''} />{mesh ? mesh.name : '모델을 불러오지 않았습니다'}</div>
            {mesh && <button onClick={() => setViewerVersion((value) => value + 1)}>보기 초기화</button>}
          </div>
          {dropActive && <div className="drop-overlay"><strong>여기에 놓아주세요</strong><span>STL 파일을 바로 열 수 있습니다</span></div>}
          {mesh
            ? <Viewer key={viewerVersion} mesh={mesh} blockCount={blockCount} objectScale={objectScale} connectors={connectors} />
            : <EmptyState onOpen={() => fileInput.current?.click()} onDemo={loadDemo} />}
          {mesh && <div className="viewer-hint">마우스로 회전 · 휠로 확대/축소</div>}
          {mesh && <div className="legend">{Array.from({ length: blockCount }, (_, index) => <span key={index}><b style={{ background: blockColors[index] }} />블록 {index + 1}</span>)}</div>}
          {files.length > 0 && <ResultPanel files={files} connectorTotal={connectorTotal} onDownload={download} onDownloadAll={downloadAll} />}
        </section>

        <aside className="inspector" aria-label="모델 정보">
          <div className="inspector-title"><span>모델 정보</span>{mesh && <em>준비됨</em>}</div>
          {mesh && scaledBounds ? <>
            <dl>
              <div><dt>삼각형</dt><dd>{mesh.triangles.toLocaleString()}개</dd></div>
              <div><dt>가로</dt><dd>{formatter.format(scaledBounds[0])} mm</dd></div>
              <div><dt>세로</dt><dd>{formatter.format(scaledBounds[1])} mm</dd></div>
              <div><dt>높이</dt><dd>{formatter.format(scaledBounds[2])} mm</dd></div>
            </dl>
            <div className="inspector-title secondary"><span>분할 위치</span><small>{cuts.length}곳</small></div>
            <ol className="cuts">{cuts.map((cut, index) => <li key={cut}><span>분할면 {index + 1}</span><strong>Z {formatter.format(cut * objectScale)} mm</strong></li>)}</ol>
          </> : <div className="inspector-empty"><span aria-hidden="true">▱</span><p>STL 파일을 열면 모델의 크기와 분할 위치를 확인할 수 있습니다.</p></div>}
          <div className={`status-card ${error ? 'error' : ''} ${busy ? 'working' : ''}`}>
            <span className="status-dot" />
            <div><strong>{error ? '확인이 필요합니다' : busy ? '처리 중입니다' : files.length ? '생성이 완료됐습니다' : '준비 상태'}</strong><p>{error || status}</p></div>
          </div>
        </aside>
      </section>
    </main>
  )
}

function StepTitle({ number, title }: { number: string; title: string }) {
  return <div className="step-title"><span>{number}</span><strong>{title}</strong><i /></div>
}

function EmptyState({ onOpen, onDemo }: { onOpen: () => void; onDemo: () => void }) {
  return <div className="empty">
    <div className="empty-visual" aria-hidden="true"><span /><span /><span /><i /></div>
    <h1>STL 파일을 열어 시작하세요</h1>
    <p>모델을 원하는 높이로 나누고, 서로 맞물리는 핀과 소켓을 자동으로 만들 수 있습니다.</p>
    <div><button className="empty-primary" onClick={onOpen}>STL 파일 열기</button><button className="empty-secondary" onClick={onDemo}>샘플 보기</button></div>
    <small>업로드 없이 브라우저에서 바로 처리됩니다</small>
  </div>
}

function ResultPanel({ files, connectorTotal, onDownload, onDownloadAll }: { files: GeneratedFile[]; connectorTotal: number; onDownload: (file: GeneratedFile) => void; onDownloadAll: () => void }) {
  return <div className="results">
    <div className="results-head"><div><span className="success-check">✓</span><span><strong>블록 생성 완료</strong><small>{files.length}개 블록 · 결합부 {connectorTotal}개</small></span></div><button onClick={onDownloadAll}>ZIP으로 모두 받기</button></div>
    <div className="result-files">{files.map((file, index) => <button key={file.name} onClick={() => onDownload(file)}><span><b style={{ background: blockColors[index] }} />블록 {index + 1}<small>{file.triangles.toLocaleString()} tris</small></span><em>STL ↓</em></button>)}</div>
  </div>
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 250)
}

function friendlyError(message: string) {
  if (/not manifold/i.test(message)) return '빈틈이 있거나 뒤집힌 면이 있는 모델입니다. 3D 편집 도구에서 메시를 복구한 뒤 다시 시도해 주세요.'
  if (/too large|exceeds/i.test(message)) return '모델이 너무 크거나 복잡합니다. 출력 크기 또는 블록 개수를 줄여 주세요.'
  return message
}

function cubeStl() {
  const points = [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `solid cube\n${faces.map((face) => `facet normal 0 0 0\n outer loop\n${face.map((index) => `  vertex ${points[index].join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid cube`
}
