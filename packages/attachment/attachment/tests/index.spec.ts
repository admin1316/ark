import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AttachmentStore, {
  AttachmentError,
  AttachmentId,
  ImageVariantId,
  isImageAdmissionError,
  requestImageDimensions,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '../src/index.ts'

describe('request image dimensions', () => {
  it('keeps small images and projects both orientations inside the exact budget', () => {
    expect(requestImageDimensions(2, 2, 4)).toEqual({ width: 2, height: 2 })
    expect(requestImageDimensions(4, 2, 4)).toEqual({ width: 2, height: 1 })
    expect(requestImageDimensions(2, 4, 4)).toEqual({ width: 1, height: 2 })
    expect(requestImageDimensions(4, 1, 1)).toEqual({ width: 1, height: 1 })
    expect(requestImageDimensions(1, 4, 1)).toEqual({ width: 1, height: 1 })
  })

  it.each([
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
    [1.5, 1, 1],
    [1, 1.5, 1],
    [1, 1, 1.5],
  ])('rejects invalid geometry %s x %s within %s pixels', (width, height, maxPixels) => {
    expect(() => requestImageDimensions(width, height, maxPixels)).toThrow(RangeError)
  })
})

const LIMITS = {
  maxImageBytes: 4,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 5,
  maxImagePixels: 4,
  maxImageDimension: 2000,
  mediaTypes: ['image/png'] as const,
}

class RecordingStore extends AttachmentStore {
  readonly imageLimits = LIMITS
  readonly calls: string[] = []
  rejectValidationAt: number | undefined
  rejectSaveAt: number | undefined

  async validateImage(input: SaveImageAttachment): Promise<void> {
    const value = input.data[0] ?? 0
    this.calls.push(`validate:${value}`)
    if (value === this.rejectValidationAt) throw new Error(`invalid:${value}`)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const value = input.data[0] ?? 0
    this.calls.push(`save:${value}`)
    if (value === this.rejectSaveAt) throw new Error(`write:${value}`)
    return {
      attachmentId: AttachmentId(`sha256:${String(value).padStart(64, '0')}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }

  override readImageRequest(
    ref: ImageAttachmentRef,
    _policy: ImageRequestPolicy,
  ): Promise<RequestImageAttachment> {
    this.calls.push(`request:${ref.name}`)
    return Promise.resolve({
      variantId: ImageVariantId(`sha256:${String(ref.bytes).padStart(64, '0')}`),
      attachment: ref,
      data: Uint8Array.of(ref.bytes),
      mediaType: ref.mediaType,
      bytes: 1,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    })
  }
}

class UnsupportedProjectionStore extends AttachmentStore {
  readonly imageLimits = LIMITS

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  saveImage(): Promise<ImageAttachmentRef> {
    throw new Error('not used')
  }

  readImage(): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }
}

function image(value: number, mediaType: ImageMediaType = 'image/png'): SaveImageAttachment {
  return { data: Uint8Array.of(value), mediaType, name: `${value}.png` }
}

describe('AttachmentStore.saveImages', () => {
  it('validates the complete batch before saving in input order', async () => {
    const store = new RecordingStore(new Context())

    const refs = await store.saveImages([image(1), image(2)])

    expect(store.calls).toEqual(['validate:1', 'validate:2', 'save:1', 'save:2'])
    expect(refs.map(ref => ref.name)).toEqual(['1.png', '2.png'])
  })

  it('rejects count, aggregate bytes, and deployment media types before validation', async () => {
    const store = new RecordingStore(new Context())

    await expect(store.saveImages([image(1), image(2), image(3)]))
      .rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
    await expect(store.saveImages([
      { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      { data: Uint8Array.of(4, 5, 6), mediaType: 'image/png' },
    ])).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
    await expect(store.saveImages([image(1, 'image/jpeg')]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })
    expect(store.calls).toEqual([])
  })

  it('starts no writes when any member fails validation', async () => {
    const store = new RecordingStore(new Context())
    store.rejectValidationAt = 2

    await expect(store.saveImages([image(1), image(2)]))
      .rejects.toThrow('invalid:2')
    expect(store.calls).toEqual(['validate:1', 'validate:2'])
  })

  it('returns no partial references when storage fails after an earlier commit', async () => {
    const store = new RecordingStore(new Context())
    store.rejectSaveAt = 2

    await expect(store.saveImages([image(1), image(2)]))
      .rejects.toThrow('write:2')
    expect(store.calls).toEqual(['validate:1', 'validate:2', 'save:1', 'save:2'])
  })
})

describe('AttachmentStore.readImageRequest', () => {
  it('reports unsupported request projection while preserving cancellation', async () => {
    const store = new UnsupportedProjectionStore(new Context())
    const ref = await new RecordingStore(new Context()).saveImage(image(1))
    await expect(store.readImageRequest(ref, { maxPixels: 1, maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PROJECTION_UNSUPPORTED' })
    const controller = new AbortController()
    const reason = new Error('cancel unsupported projection')
    controller.abort(reason)
    expect(() => store.readImageRequest(ref, { maxPixels: 1, maxBytes: 1 }, controller.signal)).toThrow(reason)
  })
})

describe('AttachmentStore imageHostPath', () => {
  it('reports no host path from a non-file-backed store', async () => {
    const store = new UnsupportedProjectionStore(new Context())
    const ref = await new RecordingStore(new Context()).saveImage(image(1))
    expect(store.imageHostPath(ref)).toBeUndefined()
  })
})

describe('isImageAdmissionError', () => {
  it('separates caller-correctable image admission failures from storage faults', () => {
    expect(isImageAdmissionError(new AttachmentError('bad bytes', 'INVALID_IMAGE'))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('bad base64', 'INVALID_IMAGE_BASE64'))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('too many', 'TOO_MANY_IMAGES'))).toBe(true)
    expect(isImageAdmissionError(Object.assign(new Error('foreign policy error'), { code: 'IMAGE_TOO_LARGE' }))).toBe(true)
    expect(isImageAdmissionError(new AttachmentError('corrupt object', 'ATTACHMENT_CORRUPT'))).toBe(false)
    expect(isImageAdmissionError(new AttachmentError('disk failed', 'ATTACHMENT_WRITE_FAILED'))).toBe(false)
    expect(isImageAdmissionError(new Error('unknown failure'))).toBe(false)
  })
})
