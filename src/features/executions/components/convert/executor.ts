import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { convertChannel } from "@/inngest/channels/convert";
import type { ConversionKind } from "@/lib/conversions";
import { type SyncConversionKind, syncConverters } from "@/lib/converters";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { fetchResumeText, isDriveSource } from "@/lib/resume-fetch";
import { renderTemplate } from "@/lib/templating";

type ConvertData = {
  conversion?: ConversionKind;
  input?: string;
};

type ConvertOutput = {
  /** The converted value: text for most conversions, an array for csv_to_json. */
  result: unknown;
  /** Which conversion produced it (echoed for self-documenting runs). */
  conversion: ConversionKind;
};

export const convertExecutor: NodeExecutor<ConvertData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(convertChannel(userId).status({ nodeId, status: "loading" }));

  let config: ConvertData;
  try {
    config = parseNodeConfig(NodeType.CONVERT, data) as ConvertData;
  } catch (error) {
    await publish(convertChannel(userId).status({ nodeId, status: "error" }));
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const conversion = config.conversion ?? "pdf_to_text";
  const input = renderTemplate(config.input ?? "", context).trim();
  if (!input) {
    await publish(convertChannel(userId).status({ nodeId, status: "error" }));
    throw new NonRetriableError("Convert: an input value is required");
  }

  try {
    let result: unknown;

    if (conversion === "pdf_to_text") {
      // Downloads the file and extracts text. Private Google Drive files need
      // the user's Google token; public URLs don't.
      const accessToken = isDriveSource(input)
        ? await refreshGoogleTokenIfNeeded(userId).catch(() => undefined)
        : undefined;
      result = await step.run("convert-pdf-to-text", async () => {
        const { text } = await fetchResumeText(input, { accessToken });
        return text;
      });
    } else {
      result = await step.run(`convert-${conversion}`, async () =>
        syncConverters[conversion as SyncConversionKind](input),
      );
    }

    await publish(convertChannel(userId).status({ nodeId, status: "success" }));

    return {
      ...context,
      [outputKey]: { result, conversion } satisfies ConvertOutput,
    };
  } catch (error) {
    await publish(convertChannel(userId).status({ nodeId, status: "error" }));
    if (error instanceof NonRetriableError) throw error;
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Conversion failed",
    );
  }
};
