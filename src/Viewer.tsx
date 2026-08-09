import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ConnectorPosition, MeshSummary } from './types'

type Props = { mesh: MeshSummary | null; blockCount: number; objectScale: number; connectors: ConnectorPosition[][] }

const palette = ['#3d7eff', '#9c75ff', '#f46f9d', '#f6a443', '#3bc3a1', '#5db5f2', '#e87bc1', '#bfd35d']

export default function Viewer({ mesh, blockCount, objectScale, connectors }: Props) {
  const mount = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = mount.current
    if (!host) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0b1324')
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100000)
    camera.position.set(6, 5, 8)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    scene.add(new THREE.HemisphereLight('#dcecff', '#16233b', 2.7))
    const key = new THREE.DirectionalLight('#ffffff', 2.4)
    key.position.set(5, 8, 6)
    scene.add(key)
    const stage = new THREE.Group()
    scene.add(stage)
    const grid = new THREE.GridHelper(10, 10, '#34506e', '#1c2c42')
    grid.position.y = -0.01
    scene.add(grid)

    if (mesh) {
      const { min, max } = mesh.bounds
      const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
      const height = Math.max(max[2] - min[2], Number.EPSILON)
      const positions = mesh.positions
      const colors = new Float32Array(positions.length)
      const color = new THREE.Color()
      for (let i = 0; i < positions.length; i += 3) {
        const segment = Math.min(blockCount - 1, Math.floor(((positions[i + 2] - min[2]) / height) * blockCount))
        color.set(palette[segment % palette.length])
        colors.set([color.r, color.g, color.b], i)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.08, side: THREE.DoubleSide })
      const object = new THREE.Mesh(geometry, material)
      object.position.copy(center).multiplyScalar(-1)
      object.scale.setScalar(objectScale)
      stage.add(object)

      const size = Math.max(max[0] - min[0], max[1] - min[1], height) * objectScale
      const planeSize = size * 1.4
      for (let cut = 1; cut < blockCount; cut += 1) {
        const z = (min[2] + (height * cut) / blockCount - center.z) * objectScale
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(planeSize, planeSize)),
          new THREE.LineBasicMaterial({ color: '#dce9ff', transparent: true, opacity: 0.62 }),
        )
        line.position.z = z
        stage.add(line)
      }
      connectors.flat().forEach((pin) => {
        const marker = new THREE.Mesh(new THREE.CylinderGeometry(1.3 * objectScale, 1.3 * objectScale, 6 * objectScale, 16), new THREE.MeshBasicMaterial({ color: '#d9f0ff', transparent: true, opacity: 0.8 }))
        marker.rotation.x = Math.PI / 2
        marker.position.set((pin.x - center.x) * objectScale, (pin.y - center.y) * objectScale, (pin.z - center.z) * objectScale)
        stage.add(marker)
      })
      grid.scale.setScalar(Math.max(1, size / 5))
      controls.target.set(0, 0, 0)
      camera.position.set(size * 1.18, size * 0.93, size * 1.3)
      camera.near = Math.max(0.001, size / 1000)
      camera.far = size * 100
      camera.updateProjectionMatrix()
    }

    const resize = () => {
      const { width, height } = host.getBoundingClientRect()
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    let frame = 0
    const animate = () => { frame = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
    animate()
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.dispose(); geometryDispose(stage); host.removeChild(renderer.domElement)
    }
  }, [mesh, blockCount, objectScale, connectors])

  return <div ref={mount} className="viewer" aria-label="STL 3D preview" />
}

function geometryDispose(group: THREE.Object3D) {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material?.dispose()
  })
}
