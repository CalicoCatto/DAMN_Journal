interface Env {
  DB: D1Database;
  SUBMISSIONS_BUCKET: R2Bucket;
  RESEND_API_KEY: string;
  EDITOR_EMAIL: string;
}

const ALLOWED_EXTENSIONS = ['.docx', '.doc', '.pdf', '.md', '.tex', '.txt', '.zip', '.rar', '.7z'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

function generateId(): string {
  return crypto.randomUUID();
}

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot === -1 ? '' : filename.slice(lastDot).toLowerCase();
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function notifyEditor(env: Env, submission: {
  id: string;
  title: string;
  authors: { name: string; affiliation: string; role: string }[];
  abstract: string;
  submitterEmail: string;
  fileName: string;
}): Promise<void> {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY === 're_placeholder') return;

  const authorsList = submission.authors
    .map(a => `${a.name}${a.affiliation ? ` (${a.affiliation})` : ''} - ${a.role}`)
    .join('<br>');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'DAMN Journal <noreply@damn-journal.pages.dev>',
        to: env.EDITOR_EMAIL,
        subject: `[DAMN 新投稿] ${submission.title}`,
        html: `
          <h2>新投稿通知</h2>
          <p><strong>投稿编号:</strong> ${submission.id}</p>
          <p><strong>标题:</strong> ${submission.title}</p>
          <p><strong>作者:</strong><br>${authorsList}</p>
          <p><strong>摘要:</strong><br>${submission.abstract.slice(0, 500)}${submission.abstract.length > 500 ? '...' : ''}</p>
          <p><strong>联系邮箱:</strong> ${submission.submitterEmail}</p>
          <p><strong>稿件文件:</strong> ${submission.fileName}</p>
          <hr>
          <p><em>此邮件由 DAMN 投稿系统自动发送</em></p>
        `,
      }),
    });
  } catch {
    // Email failure should not block submission
    console.error('Failed to send notification email');
  }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const formData = await context.request.formData();

    // Extract fields
    const title = (formData.get('title') as string || '').trim();
    const authorsRaw = formData.get('authors') as string || '[]';
    const abstract = (formData.get('abstract') as string || '').trim();
    const keywords = (formData.get('keywords') as string || '').trim();
    const submitterEmail = (formData.get('email') as string || '').trim();
    const file = formData.get('file') as File | null;

    // Validate title
    if (!title) {
      return jsonResponse({ success: false, error: '请填写论文标题 / Title is required', field: 'title' }, 400);
    }
    if (title.length > 500) {
      return jsonResponse({ success: false, error: '标题不超过500字 / Title must be under 500 characters', field: 'title' }, 400);
    }

    // Validate authors
    let authors: { name: string; affiliation: string; role: string }[];
    try {
      authors = JSON.parse(authorsRaw);
    } catch {
      return jsonResponse({ success: false, error: '作者信息格式错误 / Invalid authors format', field: 'authors' }, 400);
    }
    if (!Array.isArray(authors) || authors.length === 0) {
      return jsonResponse({ success: false, error: '至少需要一位作者 / At least one author is required', field: 'authors' }, 400);
    }
    for (const author of authors) {
      if (!author.name || !author.name.trim()) {
        return jsonResponse({ success: false, error: '每位作者必须填写姓名 / Each author must have a name', field: 'authors' }, 400);
      }
    }

    // Validate abstract
    if (!abstract) {
      return jsonResponse({ success: false, error: '请填写摘要 / Abstract is required', field: 'abstract' }, 400);
    }
    if (abstract.length > 5000) {
      return jsonResponse({ success: false, error: '摘要不超过5000字 / Abstract must be under 5000 characters', field: 'abstract' }, 400);
    }

    // Validate keywords
    if (!keywords) {
      return jsonResponse({ success: false, error: '请填写关键词 / Keywords are required', field: 'keywords' }, 400);
    }

    // Validate email
    if (!submitterEmail || !validateEmail(submitterEmail)) {
      return jsonResponse({ success: false, error: '请填写有效的联系邮箱 / A valid email is required', field: 'email' }, 400);
    }

    // Validate file
    if (!file || file.size === 0) {
      return jsonResponse({ success: false, error: '请上传稿件文件 / Manuscript file is required', field: 'file' }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return jsonResponse({ success: false, error: '文件大小不能超过20MB / File must be under 20MB', field: 'file' }, 400);
    }
    const ext = getFileExtension(file.name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return jsonResponse({ success: false, error: '不支持该文件格式 / Unsupported file format', field: 'file' }, 400);
    }

    // Generate ID and upload file to R2
    const id = generateId();
    const fileKey = `submissions/${id}/${file.name}`;

    await context.env.SUBMISSIONS_BUCKET.put(fileKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { originalName: file.name },
    });

    // Insert into D1
    await context.env.DB.prepare(
      `INSERT INTO submissions (id, title, authors_json, abstract, keywords, file_key, file_name, file_size, submitter_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, title, JSON.stringify(authors), abstract, keywords, fileKey, file.name, file.size, submitterEmail).run();

    // Send notification email (non-blocking)
    await notifyEditor(context.env, { id, title, authors, abstract, submitterEmail, fileName: file.name });

    return jsonResponse({ success: true, id });

  } catch (err) {
    console.error('Submission error:', err);
    return jsonResponse({ success: false, error: '服务器内部错误，请稍后重试 / Internal server error, please try again later' }, 500);
  }
};
