import { useEffect, useRef, useState } from "react";
import { isPromptImageReference, type PromptImageInput } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { Spinner } from "./common.js";
import { ImageOffIcon } from "./Icons.js";

/**
 * A prompt image. Protected artifact images need an Authorization header, so they render from a
 * short-lived object URL; while that is fetched the tile shows a spinner (#2177).
 *
 * An image that can't be shown — its source fails to decode, or its artifact can't be fetched — is an
 * image-off tile named by `alt`, never the browser's broken-image icon with the alt text spilling out.
 * `onBroken` reports it once per image, so the composer can say which attachment it was.
 */
export function PromptImageView({ image, alt, onBroken }: {
  image: PromptImageInput;
  alt: string;
  onBroken?: () => void;
}) {
  const api = useApi();
  const [source, setSource] = useState(() => isPromptImageReference(image)
    ? null
    : `data:${image.mimeType};base64,${image.data}`);
  // The image that failed, rather than a flag: a new image starts unbroken without a reset, and a reset
  // in the effect below would erase an error the browser reported before that effect ran.
  const [failedImage, setFailedImage] = useState<PromptImageInput | null>(null);
  const broken = failedImage === image;
  const onBrokenRef = useRef(onBroken);
  onBrokenRef.current = onBroken;

  useEffect(() => {
    if (!isPromptImageReference(image)) {
      setSource(`data:${image.mimeType};base64,${image.data}`);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setSource(null);
    void api.artifactExport(image.artifactId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(() => {
      if (active) setFailedImage(image);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, image]);

  useEffect(() => {
    if (broken) onBrokenRef.current?.();
  }, [broken]);

  if (broken) {
    return (
      <span className="image-broken" role="img" aria-label={alt}>
        <ImageOffIcon size={20} />
      </span>
    );
  }
  return source
    ? <img src={source} alt={alt} onError={() => setFailedImage(image)} />
    : <span className="image-loading" role="img" aria-label={`${alt}, loading`}><Spinner decorative /></span>;
}
