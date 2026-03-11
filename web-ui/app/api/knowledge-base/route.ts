import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { DEFAULT_TENANT_ID } from '@/lib/aws-config';

// GET /api/knowledge-base
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const knowledgeBases = await KnowledgeBaseService.listKnowledgeBases(DEFAULT_TENANT_ID);
    return NextResponse.json({ knowledgeBases });
  } catch (error) {
    console.error('[KB API] Error listing knowledge bases:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list knowledge bases' },
      { status: 500 },
    );
  }
}

// POST /api/knowledge-base
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name, description } = body as { name?: string; description?: string };

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const knowledgeBase = await KnowledgeBaseService.createKnowledgeBase(
      { name: name.trim(), description },
      DEFAULT_TENANT_ID,
      session.user?.email ?? undefined,
    );

    return NextResponse.json({ knowledgeBase }, { status: 201 });
  } catch (error) {
    console.error('[KB API] Error creating knowledge base:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create knowledge base' },
      { status: 500 },
    );
  }
}
