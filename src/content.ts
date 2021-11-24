import './polyfill'

import delay from 'delay'
import { documentToSVG, elementToSVG } from 'dom-to-svg'
import { saveAs } from 'file-saver'
import prettyBytes from 'pretty-bytes'
import formatXML from 'xml-formatter'

import { minifySvg } from './minify'
import { applyDefaults, CaptureArea, Settings, SETTINGS_KEYS } from './shared'
import { AbortError, svgNamespace, once } from './util'

async function main(): Promise<void> {
	console.log('Content script running')
	const captureMessage = once(browser.runtime.onMessage, message => message.method === 'capture')
	await browser.runtime.sendMessage({ method: 'started' })
	try {
		const [
			{
				payload: { area },
			},
		] = await captureMessage
		await capture(area)
	} catch (error) {
		if (error?.name === 'AbortError') {
			return
		}
		console.error(error)
		const errorMessage = String(error.message)
		alert(
			`An error happened while capturing the page: ${errorMessage}\nCheck the developer console for more information.`
		)
	} finally {
		await browser.runtime.sendMessage({ method: 'finished' })
	}
}

/**
 * Captures the DOM as the user requested and downloads the result.
 */
async function capture(area: CaptureArea): Promise<void> {
	console.log('Capturing', area)

	const captureElement = area === 'captureElement' ? await letUserSelectCaptureElement() : undefined
	const captureArea = area === 'captureArea' ? await letUserSelectCaptureArea() : undefined

	document.documentElement.style.cursor = 'wait'
	try {
		// Give browser chance to render
		await delay(0)

		const settings = applyDefaults((await browser.storage.sync.get(SETTINGS_KEYS)) as Settings)

		const svgDocument = captureElement
			? elementToSVG(captureElement, { keepLinks: settings.keepLinks })
			: documentToSVG(document, {
					captureArea,
					keepLinks: settings.keepLinks,
			  })

		if (captureElement) {
			const color = realBackgroundColor(captureElement)
			svgDocument.querySelector('svg')!.style.backgroundColor = color
		}

		let svgString = new XMLSerializer().serializeToString(svgDocument)

		if (settings.inlineResources) {
			console.log('Inlining resources')
			// Do post-processing in the background page
			svgString = await browser.runtime.sendMessage({
				method: 'postProcessSVG',
				payload: svgString,
			})
		}

		if (settings.minifySvg) {
			console.log('Minifying')
			svgString = await minifySvg(svgString)
		}

		if (settings.prettyPrintSvg && !settings.minifySvg) {
			console.log('Pretty-printing SVG')
			svgString = formatXML(svgString)
		}

		const blob = new Blob([svgString], { type: 'image/svg+xml' })
		console.log('SVG size after minification:', prettyBytes(blob.size))
		if (settings.target === 'download') {
			console.log('Downloading')
			saveAs(blob, `${document.title.replace(/["'/]/g, '')} Screenshot.svg`)
		} else if (settings.target === 'clipboard') {
			console.log('Copying to clipboard')
			await navigator.clipboard.writeText(svgString)
			// const plainTextBlob = new Blob([svgString], { type: 'text/plain' })
			// Copying image/svg+xml is not yet supported in Chrome and crashes the tab
			// await navigator.clipboard.write([
			// 	new ClipboardItem({
			// 		[blob.type]: blob,
			// 		'text/plain': plainTextBlob,
			// 	}),
			// ])
		} else if (settings.target === 'tab') {
			console.log('Opening in new tab')
			const url = window.URL.createObjectURL(blob)
			window.open(url, '_blank', 'noopener')
		} else {
			throw new Error(`Unexpected SVG target ${String(settings.target)}`)
		}
	} finally {
		document.documentElement.style.cursor = ''
	}
}

/**
 * Creates a UI to let the user select the capture area and returns the result.
 */
async function letUserSelectCaptureArea(): Promise<DOMRectReadOnly> {
	const { clientWidth, clientHeight } = document.documentElement

	const svgElement = document.createElementNS(svgNamespace, 'svg')
	svgElement.id = 'svg-screenshot-selector'
	svgElement.setAttribute('viewBox', `0 0 ${clientWidth} ${clientHeight}`)
	svgElement.style.position = 'fixed'
	svgElement.style.top = '0px'
	svgElement.style.left = '0px'
	svgElement.style.width = `${clientWidth}px`
	svgElement.style.height = `${clientHeight}px`
	svgElement.style.cursor = 'crosshair'
	svgElement.style.zIndex = '99999999'

	const backdrop = document.createElementNS(svgNamespace, 'rect')
	backdrop.setAttribute('x', '0')
	backdrop.setAttribute('y', '0')
	backdrop.setAttribute('width', clientWidth.toString())
	backdrop.setAttribute('height', clientHeight.toString())
	backdrop.setAttribute('fill', 'rgba(0, 0, 0, 0.5)')
	backdrop.setAttribute('mask', 'url(#svg-screenshot-cutout)')
	svgElement.append(backdrop)

	const mask = document.createElementNS(svgNamespace, 'mask')
	svgElement.prepend(mask)
	mask.id = 'svg-screenshot-cutout'

	const maskBackground = document.createElementNS(svgNamespace, 'rect')
	maskBackground.setAttribute('fill', 'white')
	maskBackground.setAttribute('x', '0')
	maskBackground.setAttribute('y', '0')
	maskBackground.setAttribute('width', clientWidth.toString())
	maskBackground.setAttribute('height', clientHeight.toString())
	mask.append(maskBackground)

	const maskCutout = document.createElementNS(svgNamespace, 'rect')
	maskCutout.setAttribute('fill', 'black')
	mask.append(maskCutout)

	let captureArea: DOMRectReadOnly
	try {
		await new Promise<void>((resolve, reject) => {
			window.addEventListener('keyup', event => {
				if (event.key === 'Escape') {
					reject(new AbortError('Aborted with Escape'))
				}
			})
			svgElement.addEventListener('mousedown', event => {
				event.preventDefault()
				const { clientX: startX, clientY: startY } = event
				svgElement.addEventListener('mousemove', event => {
					event.preventDefault()
					const positionX = Math.min(startX, event.clientX)
					const positionY = Math.min(startY, event.clientY)
					maskCutout.setAttribute('x', positionX.toString())
					maskCutout.setAttribute('y', positionY.toString())
					maskCutout.setAttribute('width', Math.abs(event.clientX - startX).toString())
					maskCutout.setAttribute('height', Math.abs(event.clientY - startY).toString())
				})
				svgElement.addEventListener(
					'mouseup',
					event => {
						event.preventDefault()
						resolve()
					},
					{ once: true }
				)
			})
			document.body.append(svgElement)
		})
		// Note: Need to build the DOMRect from the properties,
		// getBoundingClientRect() returns collapsed rectangle in Firefox
		captureArea = new DOMRectReadOnly(
			maskCutout.x.baseVal.value,
			maskCutout.y.baseVal.value,
			maskCutout.width.baseVal.value,
			maskCutout.height.baseVal.value
		)
	} finally {
		svgElement.remove()
	}

	return captureArea
}

function realBackgroundColor(element: HTMLElement): string {
	const background = getComputedStyle(element).backgroundColor
	if ((background === 'rgba(0, 0, 0, 0)' || background === 'transparent') && element.parentElement) {
		return realBackgroundColor(element.parentElement)
	}
	return background
}

async function letUserSelectCaptureElement(): Promise<HTMLElement | undefined> {
	let captureArea: HTMLElement | undefined

	const mask = document.createElement('div')
	mask.id = 'svg-screenshot-cutout'
	mask.style.zIndex = '99999999'
	mask.style.backgroundColor = 'rgba(107, 184, 237, 0.5)'
	mask.style.border = '1px solid black'
	mask.style.position = 'absolute'
	mask.style.pointerEvents = 'none'
	mask.style.width = '0px'
	mask.style.height = '0px'
	document.body.append(mask)

	try {
		await new Promise<void>((resolve, reject) => {
			window.addEventListener('keyup', event => {
				if (event.key === 'Escape') {
					reject(new AbortError('Aborted with Escape'))
				}
			})
			document.addEventListener('mousemove', event => {
				const target = event.target as HTMLElement
				const parent = target.parentElement ? target.parentElement : target
				const { left, top, width, height } = parent.getBoundingClientRect()
				mask.style.width = `${width}px`
				mask.style.height = `${height}px`
				mask.style.left = `${left + window.scrollX}px`
				mask.style.top = `${top + window.scrollY}px`
			})
			document.addEventListener('click', event => {
				const target = event.target as HTMLElement
				if (!target) {
					return
				}
				captureArea = target.parentElement ? target.parentElement : target
				resolve()
			})
		})
	} finally {
		mask.remove()
	}
	return captureArea
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main()
