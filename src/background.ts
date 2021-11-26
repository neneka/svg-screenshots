import './polyfill'

import { PutObjectCommand, S3Client, S3ClientConfig } from '@aws-sdk/client-s3'
import { inlineResources } from 'dom-to-svg'
import { v4 as uuid } from 'uuid'

browser.runtime.onMessage.addListener(async (message, sender) => {
	const { method, payload } = message
	switch (method) {
		// Disable action while a page is capturing
		case 'started': {
			await browser.browserAction.disable(sender.tab!.id)
			return
		}
		case 'finished': {
			await browser.browserAction.enable(sender.tab!.id)
			return
		}
		case 'postProcessSVG': {
			return postProcessSVG(payload)
		}
		case 'upload-s3': {
			return uploadToS3(payload)
		}
	}
})

async function postProcessSVG(svg: string): Promise<string> {
	const svgDocument = new DOMParser().parseFromString(svg, 'image/svg+xml')
	const svgRootElement = svgDocument.documentElement as Element as SVGSVGElement
	// Append to DOM so SVG elements are attached to a window/have defaultView, so window.getComputedStyle() works
	// This is safe, the generated SVG contains no JavaScript and even if it did, the background page CSP disallows any external or inline scripts.
	document.body.prepend(svgRootElement)
	try {
		await inlineResources(svgRootElement)
	} finally {
		svgRootElement.remove()
	}
	return new XMLSerializer().serializeToString(svgRootElement)
}

async function uploadToS3({
	svg,
	s3config,
	bucket,
}: {
	svg: string
	s3config: S3ClientConfig
	bucket: string
}): Promise<string> {
	const rand: string = uuid()
	const name = `${rand}.svg`
	const client = new S3Client(s3config)
	const command = new PutObjectCommand({
		Bucket: bucket,
		Key: name,
		Body: svg,
		CacheControl: 'max-age=31536000',
		ContentType: 'image/svg+xml',
	})
	await client.send(command)
	const url = new URL(s3config.endpoint?.toString() || 'https://s3.amazonaws.com/')
	url.hostname = `${bucket}.${url.hostname}`
	url.pathname = name
	return url.href
}
