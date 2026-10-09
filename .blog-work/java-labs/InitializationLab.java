public class InitializationLab {
    static final class Target {
        static final int CONSTANT = 7;
        static int runtimeValue = initialize();
        static int initialize() {
            System.out.println("Target initialized");
            return 42;
        }
    }
    public static void main(String[] args) throws Exception {
        String name = InitializationLab.class.getName() + "$Target";
        ClassLoader loader = InitializationLab.class.getClassLoader();
        System.out.println("step 1: " + Target.CONSTANT);
        Class<?> type = Class.forName(name, false, loader);
        System.out.println("step 2: " + type.getName());
        System.out.println("step 3: before initialization");
        Class.forName(name, true, loader);
        System.out.println("step 4: " + Target.runtimeValue);
    }
}