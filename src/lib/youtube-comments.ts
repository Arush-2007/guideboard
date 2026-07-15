import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";

export interface YoutubeComment {
  commentId: string;
  commentText: string;
  commenterName: string;
  videoId: string;
}

interface CommentThreadsResponse {
  items?: Array<{
    id: string;
    snippet: {
      topLevelComment: {
        snippet: {
          textDisplay: string;
          authorDisplayName: string;
        };
      };
    };
  }>;
}

export async function fetchNewYoutubeComments(
  userId: string,
  videoId: string,
  publishedAfter: Date,
): Promise<YoutubeComment[]> {
  const accessToken = await refreshYoutubeTokenIfNeeded(userId);

  const data = await http
    .get("https://www.googleapis.com/youtube/v3/commentThreads", {
      searchParams: {
        part: "snippet",
        videoId,
        publishedAfter: publishedAfter.toISOString(),
        maxResults: "50",
        order: "time",
      },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: HTTP_TIMEOUT.READ,
    })
    .json<CommentThreadsResponse>()
    .catch(
      rethrowTimeout({
        integration: "YouTube",
        timeoutClass: "READ",
        // A read is safe to repeat.
        idempotent: true,
        hint: "YouTube's API is slow right now — the next poll will pick these comments up.",
      }),
    );

  return (data.items ?? []).map((item) => ({
    commentId: item.id,
    commentText: item.snippet.topLevelComment.snippet.textDisplay,
    commenterName: item.snippet.topLevelComment.snippet.authorDisplayName,
    videoId,
  }));
}
