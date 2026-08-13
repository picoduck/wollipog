import { useEffect, useState } from "react";
import { isPromptImageReference, type PromptImageInput } from "@wollipog/protocol";
import { useApi } from "../api-context.js";

/** Protected artifact images need an Authorization header, so render a short-lived object URL. */
export function PromptImageView({ image, alt }: { image: PromptImageInput; alt: string }) {
  const api = useApi();
  const [source, setSource] = useState(() => isPromptImageReference(image)
    ? null
    : `data:${image.mimeType};base64,${image.data}`);

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
      if (active) setSource(null);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, image]);

  return source ? <img src={source} alt={alt} /> : <span className="image-loading" aria-label={`${alt} loading`} />;
}
