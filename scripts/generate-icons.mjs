import { mkdir, readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import png2icons from 'png2icons'

const { BICUBIC2, createICO, createICNS } = png2icons
await mkdir('assets', { recursive: true })
const svg = await readFile('assets/icon.svg')
const png = await sharp(svg, { density: 512 }).resize(1024, 1024).png().toBuffer()
await writeFile('assets/icon.png', png)
await sharp(png).resize(256, 256).png().toFile('assets/icon-256.png')
await sharp(png).resize(32, 32).png().toFile('assets/icon-32.png')
const ico = createICO(png, BICUBIC2, 0, true, true)
const icns = createICNS(png, BICUBIC2, 0)
if (!ico || !icns) throw new Error('Failed to generate application icons')
await writeFile('assets/icon.ico', ico)
await writeFile('assets/icon.icns', icns)
console.log(JSON.stringify({ png: png.length, ico: ico.length, icns: icns.length }))