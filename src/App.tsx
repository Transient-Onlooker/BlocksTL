import { useEffect, useMemo, useRef, useState } from 'react'
import { zip } from 'fflate'
import { CONNECTOR_PROFILE, pinDiameterFor, springCellSize } from './connectorProfile'
import { unitScaleFor } from './geometry/core'
import Viewer from './Viewer'
import type { ViewerMode } from './Viewer'
import type { BlockPreview, ConnectorPosition, FitLevel, GeneratedFile, MeshSummary, QaProjection, StlUnit, WorkerRequest, WorkerResponse } from './types'

const formatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const blockColors = ['#aeb7c2', '#17d4e5', '#f044d0', '#ffe34d', '#3866ff', '#38d26b', '#f24d4d', '#9b6cff']
const fitOptions: { level: FitLevel; label: string; note: string }[] = [
  { level: 19, label: '기본', note: '먼저 권장' },
  { level: 20, label: '타이트', note: '+0.1 mm' },
  { level: 21, label: '매우 타이트', note: '+0.2 mm' },
]

export default function App() {
  const worker = useRef<Worker | null>(null)
  const activeOperation = useRef<'load' | 'blocks' | 'fit-test' | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [mesh, setMesh] = useState<MeshSummary | null>(null)
  const [blockCount, setBlockCount] = useState(4)
  const [objectScale, setObjectScale] = useState(1)
  const [sourceUnit, setSourceUnit] = useState<StlUnit>('mm')
  const [fitLevel, setFitLevel] = useState<FitLevel>(19)
  const [status, setStatus] = useState('STL 파일을 선택해 시작하세요.')
  const [error, setError] = useState('')
  const [files, setFiles] = useState<GeneratedFile[]>([])
  const [blockPreviews, setBlockPreviews] = useState<BlockPreview[]>([])
  const [couponFiles, setCouponFiles] = useState<GeneratedFile[]>([])
  const [connectors, setConnectors] = useState<ConnectorPosition[][]>([])
  const [operation, setOperation] = useState<'load' | 'blocks' | 'fit-test' | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [viewerVersion, setViewerVersion] = useState(0)
  const [viewerMode, setViewerMode] = useState<ViewerMode>('cut')
  const [zipBusy, setZipBusy] = useState(false)

  useEffect(() => {
    const instance = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'PROGRESS') setStatus(event.data.message)
      if (event.data.type === 'ERROR') {
        setError(friendlyError(event.data.message))
        if (activeOperation.current === 'blocks' || activeOperation.current === 'load') {
          setFiles([])
          setBlockPreviews([])
          setConnectors([])
          setViewerMode('cut')
        }
        changeOperation(null)
        setStatus('설정을 확인하고 다시 시도해 주세요.')
      }
      if (event.data.type === 'STL_LOADED') {
        setMesh(event.data.mesh)
        setError('')
        setFiles([])
        setBlockPreviews([])
        setConnectors([])
        changeOperation(null)
        setViewerVersion((value) => value + 1)
        setViewerMode('cut')
        setStatus(`모델을 불러왔습니다 · 삼각형 ${event.data.mesh.triangles.toLocaleString()}개`)
      }
      if (event.data.type === 'GENERATION_STARTED') {
        setBlockPreviews([])
        setViewerMode('results')
        setStatus(`블록 0/${event.data.blockCount} · 실제 출력 형상 생성 중…`)
      }
      if (event.data.type === 'BLOCK_GENERATED') {
        const preview = event.data.preview
        setBlockPreviews((current) => [...current.filter((item) => item.index !== preview.index), preview].sort((a, b) => a.index - b.index))
        setStatus(`블록 ${preview.index + 1} · 실제 형상 QA 미리보기 준비됨`)
      }
      if (event.data.type === 'GENERATION_COMPLETE') {
        setFiles(event.data.files)
        setConnectors(event.data.connectors)
        changeOperation(null)
        setStatus(`출력 가능한 블록 ${event.data.files.length}개가 준비되었습니다.`)
      }
      if (event.data.type === 'FIT_TEST_COMPLETE') {
        setCouponFiles(event.data.files)
        changeOperation(null)
        setStatus('19·20·21 맞춤 테스트 STL 6개가 준비되었습니다.')
      }
    }
    worker.current = instance
    return () => instance.terminate()
  }, [])

  useEffect(() => {
    const saved = window.localStorage.getItem('blockstl-settings')
    if (!saved) return
    try {
      const settings = JSON.parse(saved) as { blockCount?: number; objectScale?: number; fitLevel?: number; sourceUnit?: StlUnit }
      if (settings.blockCount && settings.blockCount >= 2 && settings.blockCount <= 8) setBlockCount(settings.blockCount)
      if (settings.objectScale && settings.objectScale >= 0.25 && settings.objectScale <= 2) setObjectScale(settings.objectScale)
      if (settings.fitLevel === 19 || settings.fitLevel === 20 || settings.fitLevel === 21) setFitLevel(settings.fitLevel)
      if (settings.sourceUnit === 'mm' || settings.sourceUnit === 'inch') setSourceUnit(settings.sourceUnit)
    } catch {
      window.localStorage.removeItem('blockstl-settings')
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('blockstl-settings', JSON.stringify({ blockCount, objectScale, fitLevel, sourceUnit }))
  }, [blockCount, objectScale, fitLevel, sourceUnit])

  const cuts = useMemo(() => {
    if (!mesh) return []
    const [minZ, maxZ] = [mesh.bounds.min[2], mesh.bounds.max[2]]
    return Array.from({ length: blockCount - 1 }, (_, index) => minZ + ((index + 1) * (maxZ - minZ)) / blockCount)
  }, [blockCount, mesh])

  const modelScale = objectScale * unitScaleFor(sourceUnit)
  const scaledBounds = useMemo(() => mesh ? [
    (mesh.bounds.max[0] - mesh.bounds.min[0]) * modelScale,
    (mesh.bounds.max[1] - mesh.bounds.min[1]) * modelScale,
    (mesh.bounds.max[2] - mesh.bounds.min[2]) * modelScale,
  ] : null, [mesh, modelScale])

  const pinDiameter = pinDiameterFor(fitLevel)
  const springCell = springCellSize()
  const interference = pinDiameter - CONNECTOR_PROFILE.springGapMm
  const blockLayerHeight = scaledBounds ? scaledBounds[2] / blockCount : Infinity
  const connectorError = blockLayerHeight < CONNECTOR_PROFILE.pinHeightMm + CONNECTOR_PROFILE.roofThicknessMm
    ? '블록 한 층이 결합부보다 얇습니다. 블록 수를 줄이거나 출력 크기를 키워 주세요.'
    : ''
  const unitWarning = scaledBounds && (scaledBounds[2] < 5 || Math.max(...scaledBounds) > 2_000)
    ? `높이 ${formatter.format(scaledBounds[2])} mm — STL 좌표 단위가 ${sourceUnit === 'mm' ? 'mm' : 'inch'}인지 확인하세요.`
    : ''
  const connectorTotal = connectors.reduce((total, plan) => total + plan.length, 0)
  const busy = operation !== null || zipBusy

  function changeOperation(value: 'load' | 'blocks' | 'fit-test' | null) {
    activeOperation.current = value
    setOperation(value)
  }

  async function openFile(file: File | undefined) {
    if (!file || busy) return
    if (!file.name.toLowerCase().endsWith('.stl')) {
      setError('STL 형식의 파일만 사용할 수 있습니다.')
      return
    }
    setError('')
    setFiles([])
    setBlockPreviews([])
    setConnectors([])
    setViewerMode('cut')
    setStatus('파일을 읽고 있습니다…')
    changeOperation('load')
    const buffer = await file.arrayBuffer()
    worker.current?.postMessage({ type: 'LOAD_STL', buffer, name: file.name } satisfies WorkerRequest, [buffer])
  }

  function loadDemo() {
    if (busy) return
    const buffer = new TextEncoder().encode(cubeStl()).buffer
    setError('')
    setFiles([])
    setBlockPreviews([])
    setConnectors([])
    setViewerMode('cut')
    setStatus('샘플 모델을 준비하고 있습니다…')
    changeOperation('load')
    worker.current?.postMessage({ type: 'LOAD_STL', buffer, name: 'sample-cube.stl' } satisfies WorkerRequest, [buffer])
  }

  function generate() {
    if (!mesh || connectorError || busy) return
    setFiles([])
    setBlockPreviews([])
    setConnectors([])
    setError('')
    changeOperation('blocks')
    setStatus('블록 생성을 시작합니다…')
    worker.current?.postMessage({ type: 'GENERATE_BLOCKS', settings: { blockCount, objectScale, fitLevel, sourceUnit } } satisfies WorkerRequest)
  }

  function changeBlockCount(value: number) {
    setBlockCount(value)
    clearGeneratedResult()
  }

  function changeObjectScale(value: number) {
    setObjectScale(value)
    clearGeneratedResult()
  }

  function changeSourceUnit(value: StlUnit) {
    setSourceUnit(value)
    clearGeneratedResult()
  }

  function changeFitLevel(value: FitLevel) {
    setFitLevel(value)
    clearGeneratedResult()
  }

  function clearGeneratedResult() {
    setFiles([])
    setBlockPreviews([])
    setConnectors([])
    setViewerMode('cut')
    if (mesh) setStatus('설정이 변경되었습니다. 블록을 다시 생성해 주세요.')
  }

  async function prepareFitTest() {
    if (busy) return
    if (couponFiles.length) {
      await createArchive(couponFiles, 'BlocksTL_fit_test_19-20-21.zip', calibrationGuide())
      return
    }
    setError('')
    changeOperation('fit-test')
    setStatus('맞춤 테스트 STL을 만들고 있습니다…')
    worker.current?.postMessage({ type: 'GENERATE_FIT_TEST' } satisfies WorkerRequest)
  }

  function download(file: GeneratedFile) {
    saveBlob(new Blob([file.buffer], { type: 'model/stl' }), file.name)
  }

  async function downloadAll() {
    if (!files.length) return
    const baseName = mesh?.name.replace(/\.stl$/i, '') || 'blockstl'
    await createArchive(files, `${baseName}_blocks.zip`)
  }

  async function createArchive(archiveFiles: GeneratedFile[], name: string, guide?: string) {
    setZipBusy(true)
    setError('')
    setStatus('ZIP 파일을 백그라운드에서 만들고 있습니다…')
    try {
      await downloadArchive(archiveFiles, name, guide)
      setStatus('ZIP 다운로드가 준비되었습니다.')
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : 'ZIP 생성 중 오류가 발생했습니다.')
    } finally {
      setZipBusy(false)
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="BlocksTL 홈">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>BlocksTL</span>
        </a>
        <p>STL을 조립 가능한 블록으로 나눠보세요.</p>
        <span className="privacy-badge"><span aria-hidden="true">●</span> 내 기기에서만 처리</span>
      </header>

      <section className="workspace">
        <aside className="sidebar" aria-label="블록 생성 설정">
          <StepTitle number="1" title="STL 파일" />
          <label className={`file-button ${busy ? 'disabled' : ''}`}>
            <input ref={fileInput} type="file" accept=".stl,model/stl" disabled={busy} onChange={(event) => void openFile(event.target.files?.[0])} />
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span>STL 파일 선택</span>
            <small>Binary · ASCII, 기기에서 바로 처리</small>
          </label>
          <button className="sample-button" disabled={busy} onClick={loadDemo}>샘플 모델로 체험하기 <span>→</span></button>

          <div className="field unit-field">
            <span>STL 좌표 단위 <output>{sourceUnit === 'mm' ? 'mm' : 'inch → mm'}</output></span>
            <div className="unit-options" role="group" aria-label="STL 좌표 단위">
              <button type="button" disabled={busy} className={sourceUnit === 'mm' ? 'active' : ''} onClick={() => changeSourceUnit('mm')}>mm</button>
              <button type="button" disabled={busy} className={sourceUnit === 'inch' ? 'active' : ''} onClick={() => changeSourceUnit('inch')}>inch</button>
            </div>
            <small className="field-note">STL에는 단위 정보가 없습니다. +Z 방향을 모델 높이로 사용합니다.</small>
          </div>

          <StepTitle number="2" title="분할 설정" />
          <label className="field">
            <span>블록 개수 <output>{blockCount}개</output></span>
            <input aria-label="블록 개수" type="range" min="2" max="8" value={blockCount} disabled={busy} onChange={(event) => changeBlockCount(Number(event.target.value))} />
            <span className="range-scale"><small>2</small><small>8</small></span>
            <small className="field-note">복잡한 모델은 3~7개를 권장합니다.</small>
          </label>
          <div className="field">
            <span>출력 크기 <output>{Math.round(objectScale * 100)}%</output></span>
            <div className="scale-input"><input aria-label="출력 크기 백분율" type="number" min="25" max="200" step="5" disabled={busy} value={Math.round(objectScale * 100)} onChange={(event) => { const percent = Number(event.target.value); if (percent >= 25 && percent <= 200) changeObjectScale(percent / 100) }} /><span>%</span></div>
            <div className="scale-options">
              {[0.6, 0.8, 1, 1.25, 1.5].map((scale) => <button key={scale} type="button" disabled={busy} className={objectScale === scale ? 'active' : ''} onClick={() => changeObjectScale(scale)}>{scale * 100}%</button>)}
            </div>
            <small className="field-note">핀과 소켓 치수는 배율과 무관하게 고정됩니다.</small>
          </div>

          <StepTitle number="3" title="핀 맞춤 · 출력 보정" />
          <div className="field fit-field">
            <span>핀 맞춤 단계 <output>{fitLevel}</output></span>
            <div className="fit-options">
              {fitOptions.map((option) => <button key={option.level} type="button" disabled={busy} className={fitLevel === option.level ? 'active' : ''} onClick={() => changeFitLevel(option.level)}>
                {option.level} · {option.label}<small>{option.note}</small>
              </button>)}
            </div>
          </div>
          <p className="fit-explanation">숫자가 커질수록 수핀만 0.1 mm씩 굵어집니다. 스프링 소켓은 동일해서 결과를 직접 비교할 수 있습니다.</p>
          <div className="connector-summary">
            <span>테이퍼 원형 핀</span><span>Spring Socket V1</span><span>실험 보정값</span>
            <small>보정 수핀 Ø {pinDiameter.toFixed(1)} mm · 높이 {CONNECTOR_PROFILE.pinHeightMm} mm · 스프링 목 {CONNECTOR_PROFILE.springGapMm} mm · 간섭 {interference.toFixed(2)} mm · 셀 {springCell.width.toFixed(2)} × {springCell.depth.toFixed(2)} mm</small>
          </div>
          <button className={`fit-test-button ${couponFiles.length ? 'ready' : ''}`} type="button" disabled={busy} onClick={prepareFitTest}>
            {zipBusy ? <><span className="spinner" /> ZIP 만드는 중…</> : operation === 'fit-test' ? <><span className="spinner" /> 테스트 조각 생성 중…</> : couponFiles.length ? '맞춤 테스트 ZIP 받기' : '19·20·21 맞춤 테스트 STL 만들기'}
          </button>
          <small className="fit-test-note">본 출력 전에 6개의 작은 암·수 조각으로 프린터 공차를 확인하세요.</small>
          {unitWarning && <p className="unit-warning">{unitWarning}</p>}
          {connectorError && <p className="setting-error">{connectorError}</p>}

          <button className="generate" disabled={!mesh || busy || Boolean(connectorError)} onClick={generate}>
            {operation === 'blocks' ? <><span className="spinner" /> 블록 생성 중…</> : <>블록 생성하기 <span>→</span></>}
          </button>
          <p className="privacy-note"><span aria-hidden="true">●</span> 선택한 파일은 서버로 전송되지 않습니다.</p>
        </aside>

        <section className={`canvas-area ${dropActive ? 'drop-active' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDropActive(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDropActive(false) }}
          onDrop={(event) => { event.preventDefault(); setDropActive(false); void openFile(event.dataTransfer.files[0]) }}>
          <div className="canvas-toolbar">
            <div className="model-name"><span className={mesh ? 'ready' : ''} />{mesh ? mesh.name : '모델을 불러오지 않았습니다'}</div>
            {mesh && <div className="viewer-actions"><div className="viewer-modes"><button className={viewerMode === 'cut' ? 'active' : ''} onClick={() => setViewerMode('cut')}>Cut Preview</button><button disabled={!blockPreviews.length && operation !== 'blocks'} className={viewerMode === 'results' ? 'active' : ''} onClick={() => setViewerMode('results')}>Generated Blocks</button><button className={viewerMode === 'inspect' ? 'active' : ''} onClick={() => setViewerMode('inspect')}>3D 점검</button></div>{viewerMode === 'inspect' && <button onClick={() => setViewerVersion((value) => value + 1)}>보기 초기화</button>}</div>}
          </div>
          {dropActive && <div className="drop-overlay"><strong>여기에 놓으세요</strong><span>STL 파일을 바로 열 수 있습니다.</span></div>}
          {mesh
            ? viewerMode === 'results'
              ? <ResultPanel files={files} previews={blockPreviews} connectorTotal={connectorTotal} busy={operation === 'blocks'} archiveBusy={zipBusy} onDownload={download} onDownloadAll={downloadAll} />
              : <Viewer key={`${viewerVersion}-${viewerMode}`} mesh={mesh} blockCount={blockCount} modelScale={modelScale} connectors={connectors} connectorDiameter={pinDiameter} mode={viewerMode} />
            : <EmptyState onOpen={() => fileInput.current?.click()} onDemo={loadDemo} />}
          {mesh && viewerMode !== 'results' && <div className="viewer-hint">{viewerMode === 'cut' ? 'Z 높이별 분할 결과 · 수평선이 실제 절단면입니다' : '마우스로 회전 · 휠로 확대/축소 · Z축이 위쪽입니다'}</div>}
          {mesh && viewerMode === 'cut' && <div className="legend">{Array.from({ length: blockCount }, (_, index) => <span key={index}><b style={{ background: blockColors[index] }} />블록 {index + 1}</span>)}</div>}
        </section>

        <aside className="inspector" aria-label="모델 정보">
          <div className="inspector-title"><span>모델 정보</span>{mesh && <em>준비됨</em>}</div>
          {mesh && scaledBounds ? <>
            <dl>
              <div><dt>삼각형</dt><dd>{mesh.triangles.toLocaleString()}개</dd></div>
              <div><dt>경량 미리보기</dt><dd>{(mesh.previewPositions.length / 3).toLocaleString()}점</dd></div>
              <div><dt>가로</dt><dd>{formatter.format(scaledBounds[0])} mm</dd></div>
              <div><dt>세로</dt><dd>{formatter.format(scaledBounds[1])} mm</dd></div>
              <div><dt>높이</dt><dd>{formatter.format(scaledBounds[2])} mm</dd></div>
            </dl>
            <div className="inspector-title secondary"><span>분할 위치</span><small>{cuts.length}곳</small></div>
            <ol className="cuts">{cuts.map((cut, index) => <li key={cut}><span>분할면 {index + 1}</span><strong>Z {formatter.format(cut * modelScale)} mm</strong></li>)}</ol>
          </> : <div className="inspector-empty"><span aria-hidden="true">◇</span><p>STL 파일을 열면 모델 크기와 분할 위치를 확인할 수 있습니다.</p></div>}
          <div className={`status-card ${error ? 'error' : ''} ${busy ? 'working' : ''}`}>
            <span className="status-dot" />
            <div><strong>{error ? '확인이 필요합니다' : busy ? '처리 중입니다' : files.length ? '생성이 완료되었습니다' : '준비 상태'}</strong><p>{error || status}</p></div>
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
    <p>모델을 원하는 높이로 나누고, 서로 맞물리는 테이퍼 핀과 탄성 스프링 소켓을 자동으로 만듭니다.</p>
    <div><button className="empty-primary" onClick={onOpen}>STL 파일 열기</button><button className="empty-secondary" onClick={onDemo}>샘플 보기</button></div>
    <small>업로드 없이 브라우저에서 바로 처리합니다.</small>
  </div>
}

function ResultPanel({ files, previews, connectorTotal, busy, archiveBusy, onDownload, onDownloadAll }: { files: GeneratedFile[]; previews: BlockPreview[]; connectorTotal: number; busy: boolean; archiveBusy: boolean; onDownload: (file: GeneratedFile) => void; onDownloadAll: () => void }) {
  const visibleConnectorTotal = connectorTotal || previews.reduce((total, preview) => total + preview.topConnectorCount, 0)
  return <div className="results qa-results">
    <div className="results-head"><div><span className={`success-check ${busy || archiveBusy ? 'working' : ''}`}>{busy || archiveBusy ? <span className="spinner" /> : '✓'}</span><span><strong>{busy ? `실제 블록 생성 중 · ${previews.length}개 확인 가능` : archiveBusy ? 'ZIP을 백그라운드에서 만드는 중' : '블록 형상 QA 완료'}</strong><small>핀·소켓이 보이는지 확인하세요 · 결합부 {visibleConnectorTotal}개</small></span></div><button disabled={busy || archiveBusy || !files.length} onClick={onDownloadAll}>{busy ? '생성 중…' : archiveBusy ? 'ZIP 만드는 중…' : 'ZIP으로 모두 받기'}</button></div>
    <div className="qa-grid">{previews.map((preview) => {
      const file = files[preview.index]
      return <article className="qa-card" key={preview.index}>
        <header><span><b style={{ background: blockColors[preview.index] }} />블록 {preview.index + 1}</span><small>위 핀 {preview.topConnectorCount} · 아래 소켓 {preview.bottomConnectorCount}</small></header>
        <div className="qa-views"><figure><QaCanvas projection={preview.top} /><figcaption>{preview.topConnectorCount > 0 ? '위 결합면 · 핀' : '위 외형면'}</figcaption></figure><figure><QaCanvas projection={preview.bottom} /><figcaption>{preview.bottomConnectorCount > 0 ? '아래 결합면 · 소켓' : '아래 외형면'}</figcaption></figure><figure><QaCanvas projection={preview.side} /><figcaption>측면</figcaption></figure></div>
        <footer><span>{preview.triangles.toLocaleString()} tris</span><button disabled={!file} onClick={() => file && onDownload(file)}>{file ? 'STL 받기 ↓' : '준비 중…'}</button></footer>
      </article>
    })}</div>
  </div>
}

function QaCanvas({ projection }: { projection: QaProjection }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const image = context.createImageData(projection.width, projection.height)
    for (let index = 0; index < projection.pixels.length; index += 1) {
      const intensity = projection.pixels[index]
      const target = index * 4
      if (intensity) {
        image.data[target] = Math.min(255, intensity * 0.82 + 42)
        image.data[target + 1] = Math.min(255, intensity * 0.94 + 30)
        image.data[target + 2] = 255
        image.data[target + 3] = 255
      } else {
        image.data[target] = 8
        image.data[target + 1] = 16
        image.data[target + 2] = 28
        image.data[target + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)
  }, [projection])
  return <canvas ref={canvas} width={projection.width} height={projection.height} />
}

function downloadArchive(files: GeneratedFile[], name: string, guide?: string) {
  const entries: Record<string, Uint8Array> = Object.fromEntries(files.map((file) => [file.name, new Uint8Array(file.buffer)]))
  if (guide) entries['먼저_읽어주세요.txt'] = new TextEncoder().encode(guide)
  return new Promise<void>((resolve, reject) => {
    zip(entries, { level: 1 }, (error, archive) => {
      if (error) {
        reject(error)
        return
      }
      saveBlob(new Blob([archive as BlobPart], { type: 'application/zip' }), name)
      resolve()
    })
  })
}

function calibrationGuide() {
  return `BlocksTL 핀 맞춤 테스트\n\n1. 실제 블록과 같은 프린터·필라멘트·레이어 높이로 출력하세요.\n2. 파일 이름의 같은 번호끼리 암·수 조각을 결합하세요.\n3. 19부터 시험하고, 너무 느슨할 때만 20 또는 21로 올리세요.\n4. 무리하게 밀어 넣어 스프링이 하얗게 변하거나 깨지면 더 낮은 번호를 사용하세요.\n\n19: 수핀 5.8 mm / 총 간섭 0.15 mm\n20: 수핀 5.9 mm / 총 간섭 0.25 mm\n21: 수핀 6.0 mm / 총 간섭 0.35 mm\n\n암 스프링 소켓은 세 번호 모두 동일합니다. 번호는 수핀 지름만 바꿉니다.\n`
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
  if (/not manifold/i.test(message)) return '비어 있거나 뒤집힌 면이 있는 모델입니다. 3D 편집 도구에서 메시를 복구한 뒤 다시 시도해 주세요.'
  if (/too large|exceeds/i.test(message)) return '모델이 너무 크거나 복잡합니다. 출력 크기 또는 블록 개수를 줄여 주세요.'
  return message
}

function cubeStl() {
  const points = [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `solid cube\n${faces.map((face) => `facet normal 0 0 0\n outer loop\n${face.map((index) => `  vertex ${points[index].join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid cube`
}
