package org.lwjgl.opengl;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

// Captures the fixed-function commands used by ModelRenderer and Jammy's TESRs.
public final class GL11 {
    public interface QuadConsumer {
        void accept(String texture, double[] positions, double[] uv);
    }

    private static final Deque<double[]> stack = new ArrayDeque<>();
    private static final Map<Integer, List<double[][]>> displayLists = new HashMap<>();
    private static double[] matrix = identity();
    private static List<double[][]> compiling;
    private static int nextList = 1;
    private static String texture;
    private static QuadConsumer output;

    private GL11() {}

    public static void begin(QuadConsumer consumer) {
        if (output != null) throw new IllegalStateException("Nested capture");
        matrix = identity();
        texture = null;
        output = consumer;
    }

    public static void end() {
        if (!stack.isEmpty() || compiling != null) throw new IllegalStateException("Unbalanced GL state");
        output = null;
    }

    public static void bindTexture(String path) {
        texture = path;
    }

    public static void glPushMatrix() {
        stack.push(matrix);
    }

    public static void glPopMatrix() {
        matrix = stack.pop();
    }

    public static void glTranslatef(float x, float y, float z) {
        multiply(new double[]{1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1});
    }

    public static void glScalef(float x, float y, float z) {
        multiply(new double[]{x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1});
    }

    public static void glRotatef(float angle, float x, float y, float z) {
        double length = Math.sqrt(x * x + y * y + z * z);
        if (length == 0) throw new IllegalArgumentException("Rotation without axis");
        double nx = x / length;
        double ny = y / length;
        double nz = z / length;
        double c = Math.cos(Math.toRadians(angle));
        double s = Math.sin(Math.toRadians(angle));
        double t = 1 - c;
        multiply(new double[]{
            t * nx * nx + c, t * nx * ny - s * nz, t * nx * nz + s * ny, 0,
            t * nx * ny + s * nz, t * ny * ny + c, t * ny * nz - s * nx, 0,
            t * nx * nz - s * ny, t * ny * nz + s * nx, t * nz * nz + c, 0,
            0, 0, 0, 1,
        });
    }

    public static int glGenLists(int count) {
        int id = nextList;
        nextList += count;
        return id;
    }

    public static void glNewList(int id, int mode) {
        if (mode != 4864 || compiling != null) throw new IllegalStateException("Unexpected display-list mode " + mode);
        compiling = new ArrayList<>();
        displayLists.put(id, compiling);
    }

    public static void glEndList() {
        compiling = null;
    }

    public static void glCallList(int id) {
        for (double[][] quad : displayLists.get(id)) submitQuad(quad[0], quad[1]);
    }

    public static void submitQuad(double[] positions, double[] uv) {
        if (compiling != null) {
            compiling.add(new double[][]{positions, uv});
            return;
        }
        if (texture == null || output == null) throw new IllegalStateException("Quad without active texture or capture");
        double[] transformed = new double[positions.length];
        for (int vertex = 0; vertex < positions.length; vertex += 3) {
            for (int axis = 0; axis < 3; axis++) {
                int row = axis * 4;
                transformed[vertex + axis] = matrix[row] * positions[vertex]
                    + matrix[row + 1] * positions[vertex + 1]
                    + matrix[row + 2] * positions[vertex + 2]
                    + matrix[row + 3];
            }
        }
        output.accept(texture, transformed, uv);
    }

    private static double[] identity() {
        return new double[]{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    }

    private static void multiply(double[] next) {
        double[] result = new double[16];
        for (int row = 0; row < 4; row++) {
            for (int column = 0; column < 4; column++) {
                for (int inner = 0; inner < 4; inner++) {
                    result[row * 4 + column] += matrix[row * 4 + inner] * next[inner * 4 + column];
                }
            }
        }
        matrix = result;
    }
}
