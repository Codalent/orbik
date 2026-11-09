import { brandAssetUrl } from "@/lib/api/brand";
import { cn } from "@/lib/utils";

/**
 * One stored brand asset, shown as the image it is.
 *
 * The one place in the web app that draws a picture from the API, and so the one place that
 * decides how: a plain `<img>` whose address is the API's asset route. The session cookie travels
 * with the request, as it does with every other request to the API, and the route sends the
 * image under a policy that lets another origin show it.
 *
 * `next/image` is not used, deliberately. Its optimiser fetches the source from the Next server,
 * which holds no session and would be refused; and these are already bounded WebP and SVG files
 * the worker sized when it stored them.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} props.assetId
 * @param {string} [props.alt] what the image shows; empty for a purely decorative use
 * @param {number|null} [props.width] the stored width, so the layout does not jump as it loads
 * @param {number|null} [props.height]
 * @param {string} [props.className]
 */
export function AssetImage({ workspaceId, assetId, alt = "", width = null, height = null, className, ...props }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- served by the API under the session; next/image cannot fetch it
    <img
      src={brandAssetUrl(workspaceId, assetId)}
      alt={alt}
      width={width ?? undefined}
      height={height ?? undefined}
      loading="lazy"
      decoding="async"
      className={cn("max-w-full", className)}
      {...props}
    />
  );
}
