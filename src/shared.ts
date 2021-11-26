export type CaptureArea = 'captureArea' | 'captureViewport' | 'captureElement'
export type Target = 'download' | 'tab' | 'clipboard' | 'upload-s3'

export const SETTINGS_KEYS: readonly (keyof Settings)[] = [
	'minifySvg',
	'keepLinks',
	'inlineResources',
	'prettyPrintSvg',
	'target',
	's3Bucket',
	's3Config',
]

/**
 * The user settings stored in `browser.storage.sync`
 */
export interface Settings {
	minifySvg?: boolean
	inlineResources?: boolean
	prettyPrintSvg?: boolean
	keepLinks?: boolean
	target?: Target
	s3Bucket?: string
	s3Config?: string
}

export const applyDefaults = ({
	inlineResources = true,
	minifySvg = false,
	prettyPrintSvg = true,
	keepLinks = true,
	target = 'download',
	s3Bucket = '',
	s3Config = '',
}: Settings): Required<Settings> => ({
	inlineResources,
	minifySvg,
	keepLinks,
	prettyPrintSvg,
	target,
	s3Bucket,
	s3Config,
})
