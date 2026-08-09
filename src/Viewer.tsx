import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CONNECTOR_PROFILE } from './connectorProfile'
import type { ConnectorPosition, MeshSummary } from './types'

export type ViewerMode = 'cut' | 'inspect'

type Props = {
  mesh: MeshSummary
  blockCount: number
  objectScale: number
  connectors: ConnectorPosition[][]
  connectorDiameter: number
  mode: ViewerMode
}

const palette = ['#3d7eff', '#9c75ff', '#f46f9d', '#f6d643', '#3bc3a1', '#39bce8', '#e87bc1', '#bfd35d']

export default function Viewer({ mesh, blockCount, objectScale, connectors, connectorDiameter, mode }: Props) {
  const mount = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = mount.current
    if (!host) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0b1324')
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const { min, max } = mesh.bounds
    const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    const sourceWidth = Math.max(max[0] - min[0], 1e-6)
    const sourceDepth = Math.max(max[1] - min[1], 1e-6)
    const sourceHeight = Math.max(max[2] - min[2], 1e-6)
    const width = sourceWidth * objectScale
    const depth = sourceDepth * objectScale
    const height = sourceHeight * objectScale
    const size = Math.max(width, depth, height)
    const scaledCenter = center.clone().multiplyScalar(objectScale)

    const colors = new Float32Array(mesh.previewPositions.length)
    const color = new THREE.Color()
    for (let index = 0; index < mesh.previewPositions.length; index += 3) {
      const segment = Math.min(blockCount - 1, Math.max(0, Math.floor(((mesh.previewPositions[index + 2] - min[2]) / sourceHeight) * blockCount)))
      color.set(palette[segment % palette.length])
      colors.set([color.r, color.g, color.b], index)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.previewPositions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const material = new THREE.PointsMaterial({
      size: mode === 'cut' ? 2.1 : Math.max(size / 360, 0.1),
      sizeAttenuation: mode !== 'cut',
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: true,
    })
    const points = new THREE.Points(geometry, material)
    points.scale.setScalar(objectScale)
    points.position.copy(scaledCenter).multiplyScalar(-1)
    scene.add(points)

    let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
    let controls: OrbitControls | null = null
    if (mode === 'cut') {
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, Math.max(size * 20, 100))
      camera.up.set(0, 0, 1)
      camera.position.set(0, -Math.max(depth * 2.5, size * 1.8, 10), 0)
      camera.lookAt(0, 0, 0)
      for (let cut = 1; cut < blockCount; cut += 1) {
        const z = ((min[2] + (sourceHeight * cut) / blockCount) * objectScale) - scaledCenter.z
        const guideMaterial = new THREE.LineBasicMaterial({ color: '#dbe8f8', transparent: true, opacity: 0.72, depthTest: false })
        const guide = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size * 20, -depth / 2 - 0.1, z), new THREE.Vector3(size * 20, -depth / 2 - 0.1, z)]),
          guideMaterial,
        )
        guide.renderOrder = 10
        scene.add(guide)
      }
    } else {
      camera = new THREE.PerspectiveCamera(42, 1, Math.max(0.001, size / 1000), Math.max(size * 100, 100))
      camera.up.set(0, 0, 1)
      camera.position.set(size * 1.15, -size * 1.25, size * 0.9)
      camera.lookAt(0, 0, 0)
      controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.target.set(0, 0, 0)

      const grid = new THREE.GridHelper(Math.max(size * 1.4, 10), 12, '#34506e', '#1c2c42')
      grid.rotation.x = Math.PI / 2
      grid.position.z = -height / 2 - 0.02
      scene.add(grid)

      for (let cut = 1; cut < blockCount; cut += 1) {
        const z = ((min[2] + (sourceHeight * cut) / blockCount) * objectScale) - scaledCenter.z
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(width * 1.12, depth * 1.12)),
          new THREE.LineBasicMaterial({ color: '#dce9ff', transparent: true, opacity: 0.56 }),
        )
        line.position.z = z
        scene.add(line)
      }
      connectors.flat().forEach((pin) => {
        const markerHeight = CONNECTOR_PROFILE.pinHeightMm
        const marker = new THREE.Mesh(
          new THREE.CylinderGeometry(connectorDiameter / 2, connectorDiameter / 2, markerHeight, 20),
          new THREE.MeshBasicMaterial({ color: '#d9f0ff', transparent: true, opacity: 0.78 }),
        )
        marker.rotation.x = Math.PI / 2
        marker.position.set(pin.x - scaledCenter.x, pin.y - scaledCenter.y, pin.z - scaledCenter.z + markerHeight / 2)
        scene.add(marker)
      })
    }

    const resize = () => {
      const rect = host.getBoundingClientRect()
      const hostWidth = Math.max(rect.width, 1)
      const hostHeight = Math.max(rect.height, 1)
      renderer.setSize(hostWidth, hostHeight, false)
      const aspect = hostWidth / hostHeight
      if (camera instanceof THREE.OrthographicCamera) {
        const halfHeight = Math.max(height * 0.62, width / aspect * 0.62, 1)
        camera.left = -halfHeight * aspect
        camera.right = halfHeight * aspect
        camera.top = halfHeight
        camera.bottom = -halfHeight
      } else {
        camera.aspect = aspect
      }
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls?.update()
      renderer.render(scene, camera)
    }
    animate()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls?.dispose()
      scene.traverse(disposeObject)
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
    }
  }, [mesh, blockCount, objectScale, connectors, connectorDiameter, mode])

  return <div ref={mount} className={`viewer viewer-${mode}`} aria-label={mode === 'cut' ? 'Z 높이별 블록 Cut Preview' : '회전 가능한 3D 점검 보기'} />
}

function disposeObject(child: THREE.Object3D) {
  const mesh = child as THREE.Mesh
  mesh.geometry?.dispose()
  const material = mesh.material
  if (Array.isArray(material)) material.forEach((item) => item.dispose())
  else material?.dispose()
}
